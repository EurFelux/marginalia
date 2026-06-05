import { create } from "zustand";
import type { Chip } from "@shared/chat";
import { usePrefsStore } from "@renderer/store/prefs-store";

interface ChatState {
  activeConversationId: string | null;
  draftText: string;
  draftChips: Chip[];
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与 activeConversationId 解耦——发消息路径只设 activeConversationId、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板（经 prefs-store 布局）。 */
  openConversation: (id: string) => void;
  /** 开书恢复最近会话：同 openConversation 但不强制开面板（spec §7）。 */
  restoreConversation: (id: string) => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  openCommand: null,
};

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  openConversation: (id) => {
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    return set((s) => ({
      activeConversationId: id,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    }));
  },
  restoreConversation: (id) =>
    set((s) => ({
      activeConversationId: id,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    })),
}));
