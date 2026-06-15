// src/main/ai/send.ts
import { type ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { assemblePrompt, formatCurrentDateTime, pdfSystemNote, textOfParts } from "@main/ai/prompt";
import { buildSystemPrompt } from "@main/ai/base-prompt";
import { dedupeParagraph, toContextChips } from "@main/ai/chips";
import { type LoadBytes } from "@main/ai/tools";
import { supportsImageToolResults } from "@main/ai/model-factory";
import { getBook } from "@main/library/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import {
  appendMessage,
  getMessage,
  getLastParagraphContent,
  listMessagesAfterSeq,
  resetUserTurnForResend,
} from "@main/chat/messages";
import { t } from "@main/i18n";
import { type ResendInput, type SendInput } from "@shared/chat";
import { streamAssistantReply, type OkSendResult } from "@main/ai/stream-assistant";
export type { SendInput };

export interface SendDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /** 摘要模型解析器（auto naming 用；章节/全书摘要在 makeSummaryDeps 注入同一解析器）。不回退聊天模型——未配置则 naming/摘要跳过。 */
  resolveSummaryModel: () => ResolvedModel;
  /** 后台并发限流端口：透传给 auto-naming / 压缩；摘要在 makeSummaryDeps 注入同一单例。 */
  runBackground: RunBackground;
  /** agent 多步上限（默认 DEFAULT_STEP_LIMIT=10）；0 = 不限制（永不主动刹车，靠模型自然停止 + abort）。 */
  stepLimit?: number;
  /** 联网搜索工具工厂（注入式，便于测试 mock）；未配置则跳过注入。 */
  createSearchTools?: (
    cfg: import("@shared/web-search").WebSearchConfig,
    turnEnabled: boolean,
  ) => {
    tools: Record<string, unknown>;
    close: () => Promise<unknown>;
  };
  /** 当前联网搜索配置快照（settings 级）。 */
  webSearchConfig?: import("@shared/web-search").WebSearchConfig;
}

export type SendResult = OkSendResult | { ok: false; reason: string };

/** 选区 → AI 发送编排（设计文档 §9）。 */
export async function runSend(
  deps: SendDeps,
  input: SendInput,
  opts?: { abortSignal?: AbortSignal },
): Promise<SendResult> {
  const { db, resolveModel } = deps;

  // 1. 先解析模型——未配置即返回错误，不落库
  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // 1b. 校验会话存在且属于本书（spec §5：只校验不分配，绝不默默新建）
  const convo = db
    .select({
      bookId: conversations.bookId,
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();
  if (!convo || convo.bookId !== input.bookId) {
    return { ok: false, reason: t("errors.conversationNotFound", "会话不存在或不属于本书") };
  }
  const conversationId = input.conversationId;

  // 2. 防御过滤 off chip（正常路径 renderer 已过滤）+ 段落去重
  const activeChips = input.chips.filter((c) => c.state !== "off");
  const deduped = dedupeParagraph(activeChips, getLastParagraphContent(db, conversationId));

  // 3. 取尾轮历史（seq > S；S=null 取全量。在落入本轮 user 消息之前）
  const history = listMessagesAfterSeq(db, conversationId, convo.summarizedThroughSeq);

  // 4. 落 user 消息（chips 快照入 metadata）
  appendMessage(db, {
    conversationId,
    role: "user",
    parts: [{ type: "text", text: input.userText }],
    metadata: { contextChips: toContextChips(deduped), model: resolved.modelId },
  });

  // 5. 组装 prompt：①内置模板+②instructions+③SOUL+④记忆索引（会话快照冻结）+⑤PDF 注记
  const book = getBook(db, input.bookId);
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  let systemPromptText = buildSystemPrompt(db, conversationId);
  if (book?.format === "pdf") {
    const note = pdfSystemNote({
      pageCount: book.pageCount,
      hasTextLayer: Boolean(book.hasTextLayer),
      imageMode: imageToolResults,
    });
    systemPromptText = `${systemPromptText}\n\n${note}`;
  }
  const cfg = deps.webSearchConfig;
  const searchRegistered = Boolean(cfg?.enabled && cfg.backends.length);
  const webSearchTurn = input.webSearch ?? false;
  const webSearchEnabled = searchRegistered ? webSearchTurn : undefined;

  const allMessages: ModelMessage[] = await assemblePrompt({
    systemPrompt: systemPromptText,
    priorSummary: convo.contextSummary,
    history,
    current: {
      chips: deduped,
      userText: input.userText,
      readingContext: input.readingContext,
      currentDateTime: formatCurrentDateTime(Temporal.Now.zonedDateTimeISO()),
      webSearchEnabled,
    },
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

  // 6. 流式回复（共享尾段）
  return streamAssistantReply(
    deps,
    { conversationId, bookId: input.bookId, resolved, userText: input.userText, webSearchTurn },
    messages,
    systemPrompt,
    opts,
  );
}

/** 编辑重发 / 直接重发：设 user 文本 + 截断其后 + 从持久化消息重组 prompt + 流式。 */
export async function runResend(
  deps: SendDeps,
  input: ResendInput,
  opts?: { abortSignal?: AbortSignal },
): Promise<SendResult> {
  const { db, resolveModel } = deps;

  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const convo = db
    .select({
      bookId: conversations.bookId,
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();
  if (!convo) {
    return { ok: false, reason: t("errors.conversationNotFound", "会话不存在或不属于本书") };
  }

  const target = getMessage(db, input.userMessageId);
  if (!target || target.conversationId !== input.conversationId || target.role !== "user") {
    return { ok: false, reason: t("errors.messageNotResendable", "消息不存在或不可重发") };
  }

  // 事务：设文本 + 截断其后 + 按需重置摘要
  resetUserTurnForResend(db, input.conversationId, input.userMessageId, input.userText);

  // 重读摘要态（可能刚被重置）
  const c2 = db
    .select({
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();

  // 窗口历史（末条 = 目标 user 轮）
  const window = listMessagesAfterSeq(db, input.conversationId, c2?.summarizedThroughSeq ?? null);
  const current = window.at(-1);
  if (!current) {
    return { ok: false, reason: t("errors.messageNotResendable", "消息不存在或不可重发") };
  }
  const history = window.slice(0, -1);

  // system（同 runSend：五层组装 + PDF 注记）
  const book = getBook(db, convo.bookId);
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  let systemPromptText = buildSystemPrompt(db, input.conversationId);
  if (book?.format === "pdf") {
    const note = pdfSystemNote({
      pageCount: book.pageCount,
      hasTextLayer: Boolean(book.hasTextLayer),
      imageMode: imageToolResults,
    });
    systemPromptText = `${systemPromptText}\n\n${note}`;
  }

  const cfg = deps.webSearchConfig;
  const searchRegistered = Boolean(cfg?.enabled && cfg.backends.length);
  const webSearchTurn = input.webSearch ?? false;
  const webSearchEnabled = searchRegistered ? webSearchTurn : undefined;

  const allMessages: ModelMessage[] = await assemblePrompt({
    systemPrompt: systemPromptText,
    priorSummary: c2?.contextSummary ?? null,
    history,
    current: {
      chips: current.metadata?.contextChips ?? [],
      userText: textOfParts(current.parts),
      readingContext: null,
      currentDateTime: formatCurrentDateTime(Temporal.Now.zonedDateTimeISO()),
      webSearchEnabled,
    },
  });

  let systemPrompt: string | undefined;
  let messages: ModelMessage[];
  if (allMessages.length > 0 && allMessages[0].role === "system") {
    const sysMsg = allMessages[0];
    systemPrompt = typeof sysMsg.content === "string" ? sysMsg.content : undefined;
    messages = allMessages.slice(1);
  } else {
    messages = allMessages;
  }

  return streamAssistantReply(
    deps,
    {
      conversationId: input.conversationId,
      bookId: convo.bookId,
      resolved,
      userText: input.userText,
      webSearchTurn,
    },
    messages,
    systemPrompt,
    opts,
  );
}
