import { useEffect } from "react";
import { useChatStore } from "@renderer/store/chat-store";

/**
 * 开书恢复最近会话（spec §7）：仅当 active 为空或不属于该书时，取该书 updatedAt 最新会话
 * 装入 active（restoreConversation：载历史但不强制开面板）；该书从无会话 → active 置 null
 * 并预亮摘要 chips（「将开启新会话」状态，spec §6）。
 */
export function useRestoreConversation(bookId: string | null) {
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        if (s.activeConversationId && list.some((c) => c.id === s.activeConversationId)) return;
        const latest = list[0]; // listByBook 已按 updatedAt 倒序
        if (latest) {
          s.restoreConversation(latest.id);
        } else {
          s.setActiveConversation(null);
          s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => console.warn("[chat] restore conversation failed:", err));
    return () => {
      cancelled = true;
    };
  }, [bookId]);
}
