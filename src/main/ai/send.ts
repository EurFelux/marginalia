// src/main/ai/send.ts
import { stepCountIs, streamText, type ModelMessage, type UIMessageChunk } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import { getChapterSummary } from "@main/library/content";
import { assemblePrompt } from "@main/ai/prompt";
import { dedupeParagraph, toContextChips } from "@main/ai/chips";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { routeConversation } from "@main/chat/conversations";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
import { type SendInput } from "@shared/chat";

export interface SendDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /**
   * 触发本章摘要懒生成（fire-and-forget；通常传 ensureChapterSummary 的偏函数）。
   * 端口为 `=> void`：实现必须自含全部 reject（不让 Promise 逃逸为 unhandledRejection）。
   */
  ensureSummary: (bookId: string, chapterId: string) => void;
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
  const { db, loadBytes, resolveModel, ensureSummary, stepLimit } = deps;

  // 1. 先解析模型——未配置即返回错误，不路由/不落库（避免孤儿会话，设计文档 §16）
  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // 1b. 校验章节属于本书——在任何写入前拦截（§16 无孤儿）。否则步骤6 getChapterSummary 会在
  //     已建会话 + 已落 user 消息之后裸抛（章节存在于别的书时 FK 不报错，但 book 作用域查询无行）。
  const chapterRow = getChapter(db, input.bookId, input.currentChapterId);
  if (!chapterRow) return { ok: false, reason: "chapter not found in this book" };

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

  // 6. 章节摘要：ready 注入当前轮；pending 后台触发（不阻塞）
  const summary = getChapterSummary(db, input.bookId, input.currentChapterId);
  const chapter =
    summary.status === "ready" && summary.summary
      ? { title: chapterRow.title, summary: summary.summary }
      : null;
  if (summary.status === "pending") ensureSummary(input.bookId, input.currentChapterId);

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
  const result = streamText({
    model: resolved.model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(stepLimit ?? 5),
    abortSignal: opts?.abortSignal,
  });

  // 9. 完成时落 assistant 消息；出错不落半截
  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  // 创建 UI 流：onFinish 在流被完全消费时触发。
  // 我们需要驱动这条流（而不是 result.consumeStream()），否则 onFinish 不会触发。
  // tee 出两条流：一条内部消费（驱动 onFinish），一条暴露给调用方。
  // 用标志追踪流中是否出现错误：streamText 遇到 doStream 错误时会发 error 类型 chunk
  // 并正常关闭流（isAborted 仍为 false），因此需单独标志跳过 assistant 消息落库。
  let streamHadError = false;
  const uiStream = result.toUIMessageStream({
    onError: (err) => {
      streamHadError = true;
      console.warn("[send] stream/model error:", err);
      // onError 要求返回 string（作为 error chunk 的 errorText）
      return err instanceof Error ? err.message : String(err);
    },
    onFinish: ({ responseMessage, isAborted }) => {
      if (!isAborted && !streamHadError) {
        appendMessage(db, {
          conversationId,
          role: "assistant",
          parts: responseMessage.parts,
          metadata: { model: resolved.modelId },
        });
      }
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
      // 正常的 doStream 抛错由 SDK 转成 error chunk 并正常关流、已被 streamHadError 拦截，不会进这里；
      // 本里程碑未接 abortSignal，故亦无 user-abort 路径。记日志以便排查 DB 落库失败。
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
