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

const controllers = new Map<string, AbortController>();

export const aiBindings: Binding[] = [
  bind(C.aiSend, (req, event: IpcMainInvokeEvent): SendAck => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    controllers.set(streamId, controller);

    const result = runSend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      controllers.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      controllers.delete(streamId);
    });
    return { ok: true, conversationId: result.conversationId };
  }),

  bind(C.aiAbort, ({ streamId }) => {
    controllers.get(streamId)?.abort();
  }),
];

export function registerAiHandlers(): void {
  register(aiBindings);
}
