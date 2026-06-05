// src/main/ai/send.ts
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import { assemblePrompt } from "@main/ai/prompt";
import { dedupeParagraph, toContextChips } from "@main/ai/chips";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
import { nameConversation } from "@main/chat/conversation-title";
import { textOfParts } from "@main/ai/prompt";
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
      /** UI message stream（chunk 为 UIMessageChunk）供 UI 轨 IPC 订阅推送。 */
      stream: AsyncIterable<UIMessageChunk>;
      finished: Promise<void>;
    }
  | { ok: false; reason: string };

/** 选区 → AI 发送编排（设计文档 §9）。 */
export function runSend(
  deps: SendDeps,
  input: SendInput,
  opts?: { abortSignal?: AbortSignal },
): SendResult {
  const { db, loadBytes, resolveModel, stepLimit } = deps;

  // 1. 先解析模型——未配置即返回错误，不落库
  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // 1b. 校验会话存在且属于本书（spec §5：只校验不分配，绝不默默新建）
  const convo = db
    .select({ bookId: conversations.bookId })
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

  // 3. 取历史（在落入本轮 user 消息之前）
  const history = listMessages(db, conversationId);

  // 4. 落 user 消息（chips 快照入 metadata）
  appendMessage(db, {
    conversationId,
    role: "user",
    parts: [{ type: "text", text: input.userText }],
    metadata: { contextChips: toContextChips(deduped), model: resolved.modelId },
  });

  // 5. 组装 prompt（system 来自默认 Assistant；摘要不再隐式注入——随 chips 同构进入，spec §6）
  const assistant = getDefaultAssistant(db);
  const allMessages: ModelMessage[] = assemblePrompt({
    systemPrompt: assistant.systemPrompt,
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

  // 6. streamText + tools + agent 循环
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

  // 7. 一轮终止时落 assistant 消息——出生即终态（complete|error|aborted），设计文档 §3 / DD-§3.1 / DD-§3.2。
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
      // 首轮完成 → 自动命名（spec §5）：title 仍 null 且本轮 complete 才触发；fire-and-forget
      if (status === "complete") {
        const row = db
          .select({ title: conversations.title })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get();
        if (row && row.title == null) {
          void nameConversation(
            { db, resolveModel },
            conversationId,
            input.userText,
            textOfParts(responseMessage.parts),
          );
        }
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
    stream: callerStream,
    finished,
  };
}
