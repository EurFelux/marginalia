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
  /** 常驻摘要 toggle（spec §6）：true=on 随下条消息发送。 */
  summaryChips: { chapter: boolean; book: boolean };
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板（经 prefs-store 布局）。 */
  openConversation: (id: string) => void;
  /** 开书恢复最近会话：同 openConversation 但不强制开面板（spec §7）。 */
  restoreConversation: (id: string) => void;
  setSummaryChip: (kind: "chapter" | "book", on: boolean) => void;
  /** 「将开启新会话」预亮（spec §6）：新对话按钮 / 开书无会话。 */
  setSummaryChipsPreset: () => void;
  /** 回落全 off。 */
  resetSummaryChips: () => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  openCommand: null,
  summaryChips: { chapter: false, book: false },
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
      summaryChips: { chapter: false, book: false },
    }));
  },
  restoreConversation: (id) =>
    set((s) => ({
      activeConversationId: id,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
      summaryChips: { chapter: false, book: false },
    })),
  setSummaryChip: (kind, on) => set((s) => ({ summaryChips: { ...s.summaryChips, [kind]: on } })),
  setSummaryChipsPreset: () => set({ summaryChips: { chapter: true, book: true } }),
  resetSummaryChips: () => set({ summaryChips: { chapter: false, book: false } }),
}));
