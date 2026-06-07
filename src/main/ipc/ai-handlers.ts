import type { IpcMainInvokeEvent, WebContents } from "electron";
import { C } from "@shared/ipc";
import type { AiStreamEvent, SendAck } from "@shared/chat";
import { bind, register, type Binding } from "@main/ipc/registry";
import { runSend, type SendResult } from "@main/ai/send";
import { makeSendDeps } from "@main/ai/send-deps";

type StreamSender = Pick<WebContents, "send" | "isDestroyed">;

/** 把 runSend 的 UIMessageChunk 流逐块经 ai:chunk 推回渲染层；abort 视为正常收尾。 */
export async function pumpStream(
  sender: StreamSender,
  streamId: string,
  result: Extract<SendResult, { ok: true }>,
  signal: AbortSignal,
): Promise<void> {
  const emit = (ev: AiStreamEvent) => {
    if (!sender.isDestroyed()) sender.send(C.aiChunk.channel, ev);
  };
  try {
    for await (const chunk of result.stream) {
      if (signal.aborted) break;
      emit({ streamId, type: "chunk", chunk });
    }
    await result.finished;
    emit({ streamId, type: "finish" });
  } catch (err) {
    if (signal.aborted) emit({ streamId, type: "finish" });
    else
      emit({ streamId, type: "error", message: err instanceof Error ? err.message : String(err) });
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

  bind(C.aiAbort, ({ streamId }) => {
    activeStreams.get(streamId)?.controller.abort();
  }),
];

export function registerAiHandlers(): void {
  register(aiBindings);
}
