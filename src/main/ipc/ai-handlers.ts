import type { IpcMainInvokeEvent, WebContents } from "electron";
import { C } from "@shared/ipc";
import type { AiStreamEvent, SendAck } from "@shared/chat";
import { bind, register, type Binding } from "@main/ipc/registry";
import { runResend, runSend, type SendResult } from "@main/ai/send";
import { makeSendDeps } from "@main/ai/send-deps";
import { createLogger } from "@main/logger";

const log = createLogger("send");

type StreamSender = Pick<WebContents, "send" | "isDestroyed">;

/** 把 runSend 的 UIMessageChunk 流逐块经 ai:chunk 推回渲染层；abort 视为正常收尾。 */
export async function pumpStream(
  sender: StreamSender,
  streamId: string,
  result: Extract<SendResult, { ok: true }>,
  signal: AbortSignal,
): Promise<void> {
  // sender.send 对不可结构化克隆的载荷会**同步抛错**（如某个 chunk 含不可 clone 的值）；
  // 此前直接抛进 pumpStream catch 被静默吞掉，连是哪个 chunk 崩的都无从知晓。就地 try/catch
  // 记录失败 chunk 的类型后再抛，让外层走既有 error 收尾（error 载荷恒为纯字符串，可 clone）。
  const emit = (ev: AiStreamEvent) => {
    if (sender.isDestroyed()) return;
    try {
      sender.send(C.aiChunk.channel, ev);
    } catch (err) {
      const detail = ev.type === "chunk" ? `chunk:${ev.chunk.type}` : ev.type;
      log.warn(`ai:chunk send failed (${detail})`, err);
      throw err;
    }
  };
  // 生命周期锚点（dev 落盘）：每次发送应成对出现 start/finish；只见 start 不见 finish/warn
  // = 流卡死（finished 永不 resolve），与「报错中断」区分。
  log.debug("stream pump start", streamId);
  try {
    for await (const chunk of result.stream) {
      if (signal.aborted) break;
      emit({ streamId, type: "chunk", chunk });
    }
    await result.finished;
    log.debug("stream pump finished", streamId);
    emit({ streamId, type: "finish" });
  } catch (err) {
    // 此前本 catch 完全静默（团队补静默日志那轮漏了本处）：abort 是正常收尾仅留 debug 痕迹，
    // 其余一律 warn——否则「流式中途崩了却查无此事」。
    if (signal.aborted) {
      log.debug("stream pump aborted", streamId);
      emit({ streamId, type: "finish" });
    } else {
      log.warn("stream pump failed", err);
      emit({ streamId, type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** 在跑流注册表：streamId → abort 控制器 + 所属会话（conversation deletion 按会话中止用）。 */
const activeStreams = new Map<string, { controller: AbortController; conversationId: string }>();

/** 中止某会话的全部在跑流（conversations:delete 的前置步骤——防止删行后继续推送/落库）。 */
export function abortConversationStreams(conversationId: string): void {
  for (const s of activeStreams.values()) {
    if (s.conversationId === conversationId) s.controller.abort();
  }
}

/** 仅供测试：注册一条在跑流。 */
export function __registerStream(
  streamId: string,
  conversationId: string,
  controller: AbortController,
): void {
  activeStreams.set(streamId, { controller, conversationId });
}

/** 仅供测试：清空在跑流注册表。 */
export function __resetStreams(): void {
  activeStreams.clear();
}

export const aiBindings: Binding[] = [
  bind(C.aiSend, (req, event: IpcMainInvokeEvent): SendAck => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    activeStreams.set(streamId, { controller, conversationId: input.conversationId });

    const result = runSend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      activeStreams.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      activeStreams.delete(streamId);
    });
    return { ok: true, conversationId: result.conversationId };
  }),

  bind(C.aiResend, (req, event: IpcMainInvokeEvent): SendAck => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    activeStreams.set(streamId, { controller, conversationId: input.conversationId });
    const result = runResend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      activeStreams.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      activeStreams.delete(streamId);
    });
    return { ok: true, conversationId: result.conversationId };
  }),

  bind(C.aiAbort, ({ streamId }) => {
    activeStreams.get(streamId)?.controller.abort();
  }),
];

export function registerAiHandlers(): void {
  register(aiBindings);
}
