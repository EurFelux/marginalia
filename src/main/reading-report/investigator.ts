// src/main/reading-report/investigator.ts —— 报告 agent 的会话调查 subagent（spec 2026-08-10）。
// 纯逻辑 + 注入端口（读页、生成），不碰 Electron，可 headless 单测。
import { z } from "zod";
import { parseJsonOutput } from "@main/ai/structured-output";
import { createLogger } from "@main/logger";
import { estimateTokens } from "@shared/tokens";
import {
  SESSION_CONVERSATION_MAX_LIMIT,
  type SessionConversationMessage,
  type SessionConversationReadOptions,
  type SessionConversationReadResult,
} from "@main/reading-report/evidence";

const log = createLogger("report");

/** 单页读取的正文 token 预算：subagent 的上下文只装一个会话，可比主 agent 吃得更粗。 */
export const INVESTIGATION_PAGE_TOKEN_BUDGET = 40_000;
/** 单次调查累计读取的 token 上限；触顶即停并如实上报 truncated。 */
export const INVESTIGATION_TOTAL_TOKEN_BUDGET = 150_000;
/** 拿不到后台并发额度多久后放弃外派、让主 agent 自己翻页。 */
export const INVESTIGATION_SLOT_TIMEOUT_MS = 45_000;

const investigationPoint = z.object({
  kind: z.enum(["question", "judgment", "turn", "connection"]),
  text: z.string().min(1),
  quote: z.string().nullable().catch(null),
  seqFrom: z.number().int().nonnegative(),
  seqTo: z.number().int().nonnegative(),
});

export const investigationPageOutput = z.object({
  topic: z.string().min(1),
  points: z.array(investigationPoint),
});

export type InvestigationPoint = z.infer<typeof investigationPoint>;

export interface ConversationInvestigation {
  topic: string;
  points: InvestigationPoint[];
  coverage: {
    fromSeq: number | null;
    toSeq: number | null;
    messagesRead: number;
    /** 因累计预算触顶或分页未走完而未覆盖全部会话。 */
    truncated: boolean;
  };
}

export interface InvestigateConversationDeps {
  /** 读一页会话证据（生产实现绑定 db + session + conversationId）。 */
  readPage: (options: SessionConversationReadOptions) => SessionConversationReadResult;
  /** 单发模型调用，返回模型原始文本（生产实现走 generateText + 全局后台限流）。 */
  generate: (prompt: string) => Promise<string>;
  /** 主 agent 传下来的关注点，可为空。 */
  focus?: string;
  totalTokenBudget?: number;
  pageTokenBudget?: number;
}

export const INVESTIGATION_SYSTEM = `You investigate one conversation between a reader and a reading assistant, on behalf of a colleague writing this reader's completion report for a single reading session. Report what the reader did: the questions they raised, the judgments they formed, where their thinking turned, and the connections they drew to other books, work, or life. Do not summarize the book, and do not report the assistant's explanations except where one is needed to make a reader's move intelligible. Quote the reader verbatim whenever their own wording carries the point. Cover the whole excerpt rather than only its most quotable moments; a stretch where nothing notable happened simply yields no points.

Every point must carry the seq range of the messages it came from, so your colleague can read that stretch in full. Use the seq numbers shown in the transcript.

Output only a JSON object, no preamble:

{"topic":"what this conversation is about, one phrase","points":[{"kind":"question|judgment|turn|connection","text":"what the reader did, one or two sentences","quote":"the reader's own words, or null","seqFrom":3,"seqTo":5}]}`;

function renderTranscript(messages: SessionConversationMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === "user" ? "Reader" : "Assistant";
      const cut = message.truncated ? " …(truncated)" : "";
      return `[seq ${message.seq}] ${speaker}: ${message.text}${cut}`;
    })
    .join("\n\n");
}

function buildPagePrompt(input: {
  transcript: string;
  focus?: string;
  topic: string | null;
  background: string | null;
}): string {
  const sections = [
    input.focus ? `Your colleague is especially interested in: ${input.focus}` : null,
    input.topic ? `Topic established from earlier excerpts: ${input.topic}` : null,
    input.background
      ? `Background summary of earlier discussion (may predate this reading session; treat as context, not as evidence from it):\n${input.background}`
      : null,
    `Transcript excerpt:\n${input.transcript}`,
  ];
  return sections.filter((section) => section !== null).join("\n\n");
}

/** 模型偶发给出越界 seq；夹到本页真实范围内，避免主 agent 据此回读到空片段。 */
function clampToPage(point: InvestigationPoint, seqs: number[]): InvestigationPoint {
  const low = Math.min(...seqs);
  const high = Math.max(...seqs);
  const from = Math.min(Math.max(point.seqFrom, low), high);
  const to = Math.min(Math.max(point.seqTo, from), high);
  return { ...point, seqFrom: from, seqTo: to };
}

/**
 * 分页读完一个会话并逐页抽取读者动作，最后合并成一份要点清单。
 *
 * 刻意不做成「给 subagent 一套翻页工具、让它自己循环」：那样每页原文都会累积进 subagent 的
 * 上下文，长会话照样爆——只是把爆点从主 agent 挪到 subagent。逐页抽取则只让要点跨页累积，
 * 单次调用的上下文恒等于「一页 + 已有 topic」，与会话长度无关。
 *
 * 单页解析失败不整体失败：记 warn 后跳过该页；全部页均失败才抛错（工具层转 failed 降级）。
 */
export async function investigateConversation(
  deps: InvestigateConversationDeps,
): Promise<ConversationInvestigation> {
  const totalBudget = deps.totalTokenBudget ?? INVESTIGATION_TOTAL_TOKEN_BUDGET;
  const pageBudget = deps.pageTokenBudget ?? INVESTIGATION_PAGE_TOKEN_BUDGET;

  const points: InvestigationPoint[] = [];
  let topic: string | null = null;
  let background: string | null = null;
  let afterSeq: number | undefined;
  let spent = 0;
  let truncated = false;
  let messagesRead = 0;
  let fromSeq: number | null = null;
  let toSeq: number | null = null;
  let pages = 0;
  let failedPages = 0;

  for (;;) {
    const remaining = totalBudget - spent;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = deps.readPage({
      afterSeq,
      limit: SESSION_CONVERSATION_MAX_LIMIT,
      tokenBudget: Math.min(pageBudget, remaining),
    });

    if (page.compactedContext) background ??= page.compactedContext.summary;
    if (page.status === "compacted-only") break;

    const sessionMessages = page.messages.filter((message) => message.context === "session");
    if (page.messages.length === 0) break;

    const transcript = renderTranscript(page.messages);
    spent += estimateTokens(transcript);
    messagesRead += sessionMessages.length;
    const seqs = page.messages.map((message) => message.seq);
    fromSeq = fromSeq === null ? Math.min(...seqs) : Math.min(fromSeq, ...seqs);
    toSeq = toSeq === null ? Math.max(...seqs) : Math.max(toSeq, ...seqs);

    pages++;
    const output = await deps.generate(
      buildPagePrompt({ transcript, focus: deps.focus, topic, background }),
    );
    const parsed: z.infer<typeof investigationPageOutput> | null = parseJsonOutput(
      output,
      investigationPageOutput,
    );
    if (parsed === null) {
      failedPages++;
      log.warn(`investigation page ${pages} produced unparseable output; skipping it`);
    } else {
      topic ??= parsed.topic;
      points.push(...parsed.points.map((point) => clampToPage(point, seqs)));
    }

    if (!page.hasMore) break;
    if (page.nextAfterSeq === null) {
      truncated = true;
      break;
    }
    afterSeq = page.nextAfterSeq;
  }

  if (pages > 0 && failedPages === pages) {
    throw new Error("conversation investigation produced no parseable output");
  }
  return {
    topic: topic ?? "untitled conversation",
    points,
    coverage: { fromSeq, toSeq, messagesRead, truncated },
  };
}
