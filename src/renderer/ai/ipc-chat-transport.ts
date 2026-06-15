import type { ChatTransport, UIMessageChunk } from "ai";
import { v7 as uuidv7 } from "uuid";
import type { AiStreamEvent } from "@shared/chat";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useChatStore, getActiveConversationId } from "@renderer/store/chat-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
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
 * - bookId 读 store；conversationId 发送前懒建保证存在（spec §7）。
 * - 先订阅 ai:chunk 再 invoke ai:send（spec §4.4：订阅必早于推送，无竞态）。
 */
export function createIpcChatTransport(): ChatTransport<ChatUIMessage> {
  return {
    async sendMessages({ messages, abortSignal, trigger }) {
      const { currentBookId, readingContext } = useNavigationStore.getState();
      if (!currentBookId) {
        const { default: i18n } = await import("@renderer/i18n");
        throw new Error(i18n.t("ai.noBookToSend", "没有正在阅读的书，无法发送。"));
      }
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      if (trigger === "regenerate-message") {
        // 重发/编辑/再生成：目标 user 轮 = messages.at(-1)（regenerate 已移除其后 assistant）
        const conversationId = getActiveConversationId();
        if (!conversationId || !last) {
          void stream.cancel();
          const { default: i18n } = await import("@renderer/i18n");
          throw new Error(i18n.t("ai.cannotResend", "无法重发：找不到会话或目标消息"));
        }
        const webSearch = usePrefsStore.getState().webSearchEnabled;
        const ack = await window.api.ai.resend({
          streamId,
          conversationId,
          userMessageId: last.id,
          userText,
          webSearch,
        });
        if (!ack.ok) {
          void stream.cancel();
          throw new Error(ack.reason);
        }
        return stream;
      }

      // 新发：保证会话存在（无 active → 懒建）
      let conversationId = getActiveConversationId();
      if (!conversationId) {
        const convo = await window.api.chat.conversations.create({ bookId: currentBookId });
        useChatStore.getState().setActiveConversation(convo.id);
        conversationId = convo.id;
      }
      const chips = (last?.metadata?.contextChips ?? []).filter((c) => c.state !== "off");
      const webSearch = usePrefsStore.getState().webSearchEnabled;
      const ack = await window.api.ai.send({
        streamId,
        bookId: currentBookId,
        conversationId,
        chips,
        userText,
        readingContext,
        webSearch,
      });
      if (!ack.ok) {
        void stream.cancel(); // 触发 cancel() → 退订，避免监听器泄漏
        throw new Error(ack.reason); // useChat 进 error 态
      }
      return stream;
    },
    // 单窗口竖切不做断线重连。
    reconnectToStream: async () => null,
  };
}
