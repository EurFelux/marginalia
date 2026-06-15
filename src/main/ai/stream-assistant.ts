// src/main/ai/stream-assistant.ts
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { eq } from "drizzle-orm";
import { conversations } from "@main/db/schema";
import { createReadingTools } from "@main/ai/tools";
import { createMemoryTools } from "@main/ai/memory-tools";
import { providerCallOptions, supportsImageToolResults } from "@main/ai/model-factory";
import { withPromptCaching } from "@main/ai/prompt-caching";
import { maybeCompactConversation } from "@main/ai/context-compaction";
import { nameConversation } from "@main/chat/conversation-title";
import { appendMessage } from "@main/chat/messages";
import { textOfParts } from "@main/ai/prompt";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { SendDeps } from "@main/ai/send";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
import { createLogger } from "@main/logger";

const log = createLogger("send");

type ResolvedOk = Extract<ResolvedModel, { ok: true }>;

/** runSend / runResend 共用的成功返回形状。 */
export interface OkSendResult {
  ok: true;
  conversationId: string;
  /** UI message stream（chunk 为 UIMessageChunk）供 UI 轨 IPC 订阅推送。 */
  stream: AsyncIterable<UIMessageChunk>;
  finished: Promise<void>;
}

export interface StreamCtx {
  conversationId: string;
  bookId: string;
  resolved: ResolvedOk;
  /** 本轮 user 文本（首轮自动命名用）。 */
  userText: string;
  webSearchTurn: boolean;
}

/**
 * 共享流式尾段：streamText + tools 跑 agent 循环，一轮终止时落终态 assistant
 * （complete|error|aborted），首轮自动命名 + 轮后压缩。从 runSend 抽出供 runResend 复用。
 */
export function streamAssistantReply(
  deps: SendDeps,
  ctx: StreamCtx,
  messages: ModelMessage[],
  systemPrompt: string | undefined,
  opts?: { abortSignal?: AbortSignal },
): OkSendResult {
  const { db, loadBytes, resolveSummaryModel, stepLimit, runBackground } = deps;
  const { conversationId, bookId, resolved } = ctx;
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  const memoryTools = createMemoryTools({ db, bookId });

  let closeSearch: (() => Promise<unknown>) | undefined;
  const wsCfg = deps.webSearchConfig;
  const searchTools =
    deps.createSearchTools && wsCfg?.backends.length
      ? (() => {
          const s = deps.createSearchTools!(wsCfg, ctx.webSearchTurn);
          closeSearch = s.close;
          return s.tools;
        })()
      : {};

  const tools = {
    ...createReadingTools({ db, bookId, loadBytes, imageToolResults }),
    ...Object.fromEntries(
      Object.entries(memoryTools).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] != null,
      ),
    ),
    ...searchTools,
  };

  let capturedUsage: LanguageModelUsage | undefined;
  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;
  // 按 provider 应用 prompt caching 策略（显式断点型如 Anthropic 标 cache_control；隐式型原样透传）。
  const cached = withPromptCaching({
    providerType: resolved.providerType,
    system: systemPrompt,
    messages,
  });
  const result = streamText({
    model: resolved.model,
    system: cached.system,
    messages: cached.messages,
    tools,
    providerOptions: providerCallOptions(resolved.providerType),
    stopWhen: limit === 0 ? () => false : stepCountIs(limit),
    abortSignal: opts?.abortSignal,
    onFinish: ({ totalUsage }) => {
      capturedUsage = totalUsage;
    },
    onStepFinish: ({ finishReason, toolCalls, text }) => {
      log.debug(
        `step finished (finishReason=${finishReason}, toolCalls=${toolCalls.length}, textChars=${text.length})`,
      );
    },
  });

  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  let streamHadError = false;
  let errorInfo: { name: string; message: string } | undefined;
  const uiStream = result.toUIMessageStream({
    onError: (err) => {
      streamHadError = true;
      errorInfo = {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      };
      log.warn("stream/model error", err);
      return errorInfo.message;
    },
    onFinish: ({ responseMessage, isAborted }) => {
      const stillExists = db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get();
      if (!stillExists) {
        log.debug("conversation deleted mid-stream; dropping assistant persist", conversationId);
        return;
      }
      const status = streamHadError ? "error" : isAborted ? "aborted" : "complete";
      const usage =
        capturedUsage?.inputTokens != null && capturedUsage.outputTokens != null
          ? { inputTokens: capturedUsage.inputTokens, outputTokens: capturedUsage.outputTokens }
          : undefined;
      appendMessage(db, {
        conversationId,
        role: "assistant",
        parts: responseMessage.parts,
        status,
        metadata: {
          model: resolved.modelId,
          usage,
          error: streamHadError ? errorInfo : undefined,
        },
      });
      if (status === "complete") {
        const assistantText = textOfParts(responseMessage.parts);
        const row = db
          .select({ title: conversations.title })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get();
        if (assistantText && row && row.title == null) {
          void nameConversation(
            { db, resolveModel: resolveSummaryModel, runBackground },
            conversationId,
            ctx.userText,
            assistantText,
          );
        }
        void maybeCompactConversation(
          { db, resolveModel: resolveSummaryModel, runBackground },
          conversationId,
        );
      }
    },
  });

  const [internalStream, callerStream] = uiStream.tee();
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of internalStream) {
        // drain
      }
    } catch (err) {
      log.warn("assistant persist / stream drain failed", err);
    } finally {
      void closeSearch?.();
      resolveDone();
    }
  })();

  return { ok: true, conversationId, stream: callerStream, finished };
}
