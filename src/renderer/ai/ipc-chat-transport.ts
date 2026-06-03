import type { ChatTransport, UIMessageChunk } from "ai";
import { v7 as uuidv7 } from "uuid";
import type { AiStreamEvent } from "@shared/chat";
import { useReaderStore } from "@renderer/store/reader-store";
import { useChatStore } from "@renderer/store/chat-store";
import type { ChatUIMessage } from "@renderer/ai/types";

/** onChunk 订阅器签名（与 window.api.ai.onChunk 一致；测试可注入假实现）。 */
type OnChunk = (streamId: string, cb: (ev: AiStreamEvent) => void) => () => void;

/**
 * 纯函数：把 ai:chunk 事件流重组为 ReadableStream<UIMessageChunk>。
 * chunk → enqueue；finish → close；error → error。任一收尾都退订。
 * 抽出以便 headless 单测（不碰 window.api / DOM）。
 */
export function createEventStream(
  streamId: string,
  onChunk: OnChunk,
): ReadableStream<UIMessageChunk> {
  let unsub: (() => void) | undefined;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      unsub = onChunk(streamId, (ev) => {
        if (ev.type === "chunk") controller.enqueue(ev.chunk);
        else if (ev.type === "finish") {
          controller.close();
          unsub?.();
        } else {
          controller.error(new Error(ev.message));
          unsub?.();
        }
      });
    },
    cancel() {
      unsub?.();
    },
  });
}

/** 末条用户消息的纯文本（拼接其全部 text parts）。 */
function lastUserText(messages: ChatUIMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  return last.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * 自定义 ChatTransport：经 IPC（ai:send / ai:abort / ai:chunk）对接主进程 runSend。
 * - 历史不上送（spec §4.1：主进程是会话历史唯一真源，从 DB 装配 prompt）。
 * - userText + chips 取自「刚发出的那条用户消息」（chips 在 metadata.contextChips），
 *   而非读 store.draftChips——避免与 Composer 发送后同步清空 draftChips 的竞态
 *   （仍满足 §4.1「userText + chips 同行」）。
 * - bookId / currentChapterId / activeConversationId 为稳定态，仍读 store。
 * - 先订阅 ai:chunk 再 invoke ai:send（spec §4.4：订阅必早于推送，无竞态）。
 */
export function createIpcChatTransport(): ChatTransport<ChatUIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const { currentBookId, currentChapterId } = useReaderStore.getState();
      const { activeConversationId } = useChatStore.getState();
      if (!currentBookId || !currentChapterId) {
        const { default: i18n } = await import("@renderer/i18n");
        throw new Error(i18n.t("ai.noChapterToSend", "没有正在阅读的章节，无法发送。"));
      }
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      const chips = last?.metadata?.contextChips ?? [];

      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      const ack = await window.api.ai.send({
        streamId,
        bookId: currentBookId,
        currentChapterId,
        activeConversationId,
        chips,
        userText,
      });
      if (!ack.ok) {
        void stream.cancel(); // 触发 cancel() → 退订，避免监听器泄漏
        throw new Error(ack.reason); // useChat 进 error 态
      }
      useChatStore.getState().setActiveConversation(ack.conversationId); // ack 回写（组件外）
      return stream;
    },
    // 单窗口竖切不做断线重连。
    reconnectToStream: async () => null,
  };
}
