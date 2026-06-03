import { create } from "zustand";
import type { Chip } from "@shared/chat";
import { usePrefsStore } from "@renderer/store/prefs-store";

interface ChatState {
  activeConversationId: string | null;
  /** 显示中会话所属章；独立会话/无 active 为 null。 */
  activeConversationChapterId: string | null;
  draftText: string;
  draftChips: Chip[];
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与 activeConversationId 解耦——发消息 ack 路径只设 activeConversationId、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
}
interface ChatActions {
  setActiveConversation: (id: string | null, chapterId?: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板（经 prefs-store 布局）。 */
  openConversation: (id: string, chapterId: string | null) => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  activeConversationChapterId: null,
  draftText: "",
  draftChips: [],
  openCommand: null,
};

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (id, chapterId) =>
    set({
      activeConversationId: id,
      activeConversationChapterId: id === null ? null : (chapterId ?? null),
    }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  openConversation: (id, chapterId) => {
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    return set((s) => ({
      activeConversationId: id,
      activeConversationChapterId: chapterId,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    }));
  },
}));
