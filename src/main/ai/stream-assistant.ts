// src/main/ai/stream-assistant.ts
import {
  isStepCount,
  streamText,
  toUIMessageStream,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { eq } from "drizzle-orm";
import { conversations } from "@main/db/schema";
import { createContextTools } from "@main/ai/context-tools";
import { createMemoryTools } from "@main/ai/memory-tools";
import { providerCallOptions, supportsImageToolResults } from "@main/ai/model-factory";
import { finishFeedback } from "@main/ai/finish-feedback";
import { withPromptCaching } from "@main/ai/prompt-caching";
import { maybeCompactConversation } from "@main/ai/context-compaction";
import { maybeConsolidateMemory } from "@main/ai/memory-consolidation";
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
  bookId: string | null;
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
  const { db, loadBytes, resolveSummaryModel, stepLimit, runBackground, notify } = deps;
  const { conversationId, bookId, resolved } = ctx;
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  const memoryTools = createMemoryTools({ db });

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

  const contextTools = createContextTools({ db, bookId, loadBytes, imageToolResults });
  const tools = {
    ...contextTools,
    ...Object.fromEntries(
      Object.entries(memoryTools).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] != null,
      ),
    ),
    ...searchTools,
  };

  let capturedUsage: LanguageModelUsage | undefined;
  // 流级错误标志：仅由 streamText 的 onError 置位——它只在流中出现 error chunk 时触发。
  // 工具层错误（非法 JSON / 参数不合 schema / 未知工具 / execute 抛错）走 tool-error part，
  // SDK 将其作为工具结果喂回模型、循环继续，不算流级错误（spec 2026-09-24 chat-turn-outcome）。
  let streamHadError = false;
  let errorInfo: { name: string; message: string } | undefined;
  // 最后一步的 finish reason：取自 onStepEnd（先于 UI finish chunk 到达），供落库与反馈共用判定。
  let lastFinish: { finishReason: FinishReason; rawFinishReason: string | undefined } | undefined;
  /** 本轮需给用户的反馈；已出现流级错误的回合不再追加（每轮至多一条错误反馈）。 */
  const turnFeedback = () => (streamHadError || !lastFinish ? null : finishFeedback(lastFinish));
  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;
  // 按 provider 应用 prompt caching 策略（显式断点型如 Anthropic 标 cache_control；隐式型原样透传）。
  const cached = withPromptCaching({
    providerType: resolved.providerType,
    system: systemPrompt,
    messages,
  });
  const result = streamText({
    model: resolved.model,
    // 顶层 reasoning（v7）：SDK 按 provider 翻译成各自原生推理配置；undefined = provider 默认。
    reasoning: resolved.reasoningEffort,
    instructions: cached.system,
    messages: cached.messages,
    tools,
    providerOptions: providerCallOptions(resolved.providerType),
    stopWhen: limit === 0 ? () => false : isStepCount(limit),
    abortSignal: opts?.abortSignal,
    // v7: onFinish→onEnd；事件的 usage 现为全步累计（= v6 的 totalUsage），语义不变。
    onEnd: ({ usage }) => {
      capturedUsage = usage;
    },
    onError: ({ error }) => {
      streamHadError = true;
      errorInfo = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
      log.warn("stream/model error", error);
    },
    onStepEnd: ({ finishReason, rawFinishReason, toolCalls, text }) => {
      lastFinish = { finishReason, rawFinishReason };
      log.debug(
        `step finished (finishReason=${finishReason}, toolCalls=${toolCalls.length}, textChars=${text.length})`,
      );
    },
  });

  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  const uiStream = toUIMessageStream({
    stream: result.stream,
    // 仅把错误格式化为 errorText：除 error chunk 外，tool-input-error / tool-output-error 也经此取文案，
    // 故不能据此判定流级错误（见上方 streamHadError）。流级错误已在 streamText onError 记过日志。
    // 非法工具调用会先后经过两次：tool-input-error 带原始错误对象，SDK 随后合成的 tool-output-error
    // 只带其文案字符串——跳过字符串，一次失败只留一条 warn。
    onError: (err) => {
      if (!streamHadError && typeof err !== "string") {
        log.warn("tool call failed (error returned to model)", err);
      }
      return err instanceof Error ? err.message : String(err);
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
      const feedback = isAborted ? null : turnFeedback();
      const status =
        streamHadError || feedback?.code === "provider-error"
          ? "error"
          : isAborted
            ? "aborted"
            : "complete";
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
          finish:
            feedback && lastFinish
              ? { reason: lastFinish.finishReason, raw: lastFinish.rawFinishReason }
              : undefined,
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
        void maybeConsolidateMemory(
          { db, resolveModel: resolveSummaryModel, runBackground, notify },
          conversationId,
        );
      }
    },
  });

  const [internalStream, rawCallerStream] = uiStream.tee();
  // 仅给渲染层那一路：异常 finish reason 在 finish chunk 前补一条 error chunk，复用既有错误横幅。
  // 落库那一路不经此变换（status 由 onFinish 判定）。
  const callerStream = rawCallerStream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          const feedback = turnFeedback();
          if (feedback) controller.enqueue({ type: "error", errorText: feedback.message });
        }
        controller.enqueue(chunk);
      },
    }),
  );
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
