// src/main/ai/send.ts
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import { getChapterSummaryView } from "@main/ai/summary";
import { assemblePrompt } from "@main/ai/prompt";
import { dedupeParagraph, toContextChips } from "@main/ai/chips";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { routeConversation } from "@main/chat/conversations";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
import { t } from "@main/i18n";
import { type SendInput } from "@shared/chat";
export type { SendInput };

export interface SendDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /** agent 多步上限（默认 5）。 */
  stepLimit?: number;
}

export type SendResult =
  | {
      ok: true;
      conversationId: string;
      created: boolean;
      switchedFromActive: boolean;
      /** UI message stream（chunk 为 UIMessageChunk）供 UI 轨 IPC 订阅推送。 */
      stream: AsyncIterable<UIMessageChunk>;
      finished: Promise<void>;
    }
  | { ok: false; reason: string };

function getChapter(
  db: DB,
  bookId: string,
  chapterId: string,
): { title: string | null } | undefined {
  return db
    .select({ title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
}

/** 选区 → AI 发送编排（设计文档 §9）。 */
export function runSend(
  deps: SendDeps,
  input: SendInput,
  opts?: { abortSignal?: AbortSignal },
): SendResult {
  const { db, loadBytes, resolveModel, stepLimit } = deps;

  // 1. 先解析模型——未配置即返回错误，不路由/不落库（避免孤儿会话，设计文档 §16）
  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // 1b. 校验章节属于本书——在任何写入前拦截（§16 无孤儿）。否则步骤6 getChapterSummaryView 会在
  //     已建会话 + 已落 user 消息之后裸抛（章节存在于别的书时 FK 不报错，但 book 作用域查询无行）。
  const chapterRow = getChapter(db, input.bookId, input.currentChapterId);
  if (!chapterRow) return { ok: false, reason: t("errors.chapterNotInBook", "本书中未找到该章节") };

  // 2. 路由会话
  const route = routeConversation(db, {
    bookId: input.bookId,
    currentChapterId: input.currentChapterId,
    activeConversationId: input.activeConversationId,
  });
  const conversationId = route.conversationId;

  // 3. 段落去重（对照本会话上一次插入的段落）
  const deduped = dedupeParagraph(input.chips, getLastParagraphContent(db, conversationId));

  // 4. 取历史（在落入本轮 user 消息之前）
  const history = listMessages(db, conversationId);

  // 5. 落 user 消息（chips 快照入 metadata）
  appendMessage(db, {
    conversationId,
    role: "user",
    parts: [{ type: "text", text: input.userText }],
    metadata: { contextChips: toContextChips(deduped), model: resolved.modelId },
  });

  // 6. 章节摘要：ready 则注入当前轮（生成由「开章自动/手动」触发，不再由发消息触发）
  const summary = getChapterSummaryView(db, input.bookId, input.currentChapterId);
  const chapter =
    summary.status === "ready" && summary.summary
      ? { title: chapterRow.title, summary: summary.summary }
      : null;

  // 7. 组装 prompt（system 来自默认 Assistant）
  const assistant = getDefaultAssistant(db);
  const allMessages: ModelMessage[] = assemblePrompt({
    systemPrompt: assistant.systemPrompt,
    chapter,
    history,
    current: { chips: deduped, userText: input.userText },
  });

  // 将首个 system 消息提取出来，通过 system: 参数传给 streamText（避免 allowSystemInMessages 警告）
  let systemPrompt: string | undefined;
  let messages: ModelMessage[];
  if (allMessages.length > 0 && allMessages[0].role === "system") {
    const sysMsg = allMessages[0];
    systemPrompt = typeof sysMsg.content === "string" ? sysMsg.content : undefined;
    messages = allMessages.slice(1);
  } else {
    messages = allMessages;
  }

  // 8. streamText + tools + agent 循环
  const tools = createReadingTools({ db, bookId: input.bookId, loadBytes });
  // 从 streamText 自身的 onFinish 旁路捕获跨步聚合用量（toUIMessageStream 的 onFinish 不带 usage）。
  let capturedUsage: LanguageModelUsage | undefined;
  const result = streamText({
    model: resolved.model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(stepLimit ?? 5),
    abortSignal: opts?.abortSignal,
    onFinish: ({ totalUsage }) => {
      capturedUsage = totalUsage;
    },
  });

  // 9. 一轮终止时落 assistant 消息——出生即终态（complete|error|aborted），设计文档 §3 / DD-§3.1 / DD-§3.2。
  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  // streamText 遇 doStream 错误时发 error chunk 并正常关流（isAborted 仍 false），故用 streamHadError 标志区分；
  // 用户中止经 abortSignal → onFinish 的 isAborted=true（SDK 权威信号，非嗅探 AbortError，DD-§3.2）。
  // 两种终止都补落带终态的 assistant（不再用双守卫跳过 → 不再产生孤儿 user turn）。
  let streamHadError = false;
  let errorInfo: { name: string; message: string } | undefined;
  const uiStream = result.toUIMessageStream({
    onError: (err) => {
      streamHadError = true;
      errorInfo = {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      };
      console.warn("[send] stream/model error:", err);
      // onError 要求返回 string（作为 error chunk 的 errorText，供 renderer 实时显示）
      return errorInfo.message;
    },
    onFinish: ({ responseMessage, isAborted }) => {
      const status = streamHadError ? "error" : isAborted ? "aborted" : "complete";
      const usage =
        capturedUsage?.inputTokens != null && capturedUsage.outputTokens != null
          ? { inputTokens: capturedUsage.inputTokens, outputTokens: capturedUsage.outputTokens }
          : undefined;
      appendMessage(db, {
        conversationId,
        role: "assistant",
        parts: responseMessage.parts, // 完整 / 中止前的 partial / 报错前已流出
        status,
        metadata: {
          model: resolved.modelId,
          usage,
          error: streamHadError ? errorInfo : undefined,
        },
      });
    },
  });

  // tee：[consumer, caller]
  const [internalStream, callerStream] = uiStream.tee();

  // 驱动内部流到完成（触发 onFinish）；出错吞掉但仍 resolve finished
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of internalStream) {
        // drain
      }
    } catch (err) {
      // 防御性：仅当 UI 流在迭代中真正 reject 时到这（如 onFinish 内 appendMessage DB 写入抛错）。
      // 正常的 doStream 抛错（→ error chunk）与用户 abort（→ onFinish isAborted）都正常关流、
      // 在 onFinish 落终态 assistant 消息，不会进这里。记日志以便排查 DB 落库失败。
      console.warn("[send] assistant persist / stream drain failed:", err);
    } finally {
      // 无论成功/错误，都 resolve finished，避免上层 await 永挂
      resolveDone();
    }
  })();

  return {
    ok: true,
    conversationId,
    created: route.created,
    switchedFromActive: route.switchedFromActive,
    stream: callerStream,
    finished,
  };
}
