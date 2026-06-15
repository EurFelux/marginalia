import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Chip } from "@shared/chat";
import { openPanelAndFocusComposer } from "@renderer/ai/composer-focus";
import { safeStorage } from "@renderer/store/lazy-storage";
import type { ChatContext } from "@renderer/ai/chat-context";

interface ChatState {
  draftText: string;
  draftChips: Chip[];
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与「当前 active 会话」解耦——发消息路径只写记忆槽、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
  /** 常驻摘要 toggle（spec §6）：true=on 随下条消息发送。 */
  summaryChips: { chapter: boolean; book: boolean };
  /**
   * 每本书上次 active 的会话（视图记忆，唯一真相 + persist 持久化字段之一）。
   * 值 = 会话 id；null = 上次停在「将开新会话」空态；缺键 = 该书从无记忆（回落最新）。
   * 「当前 active 会话」由此派生（见 useActiveConversationId / getActiveConversationId），不独立存储。
   */
  activeByBook: Record<string, string | null>;
  /**
   * 书库伴侣（library 上下文）的 active 会话（持久化）。
   */
  activeLibraryConversation: string | null;
}
interface ChatActions {
  /** 设指定上下文的 active（写记忆槽）；id=null 同时清 openCommand（其载入命令失效）。 */
  setActiveConversation: (ctx: ChatContext, id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 写记忆槽 + 开面板（经 prefs-store 布局）。 */
  openConversation: (ctx: ChatContext, id: string) => void;
  /** 开书恢复会话：同 openConversation 但不强制开面板（spec §7）。 */
  restoreConversation: (ctx: ChatContext, id: string) => void;
  setSummaryChip: (kind: "chapter" | "book", on: boolean) => void;
  /** 「将开启新会话」预亮（spec §6）：新对话按钮 / 开书无会话。 */
  setSummaryChipsPreset: () => void;
  /** 回落全 off。 */
  resetSummaryChips: () => void;
  /** 切书重置：仅清残留 openCommand（避免 AIPanel 重挂重放上本书会话）；保留 activeByBook 与草稿。 */
  resetForBookSwitch: () => void;
}

export const CHAT_INITIAL: ChatState = {
  draftText: "",
  draftChips: [],
  openCommand: null,
  summaryChips: { chapter: false, book: false },
  activeByBook: {},
  activeLibraryConversation: null,
};

export const useChatStore = create<ChatState & ChatActions>()(
  persist(
    (set) => ({
      ...CHAT_INITIAL,
      setActiveConversation: (ctx, id) =>
        set((s) =>
          ctx.kind === "book"
            ? {
                activeByBook: { ...s.activeByBook, [ctx.bookId]: id },
                ...(id === null ? { openCommand: null } : {}),
              }
            : {
                activeLibraryConversation: id,
                ...(id === null ? { openCommand: null } : {}),
              },
        ),
      setDraftText: (draftText) => set({ draftText }),
      setDraftChips: (draftChips) => set({ draftChips }),
      openConversation: (ctx, id) => {
        openPanelAndFocusComposer();
        return set((s) => ({
          openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
          summaryChips: { chapter: false, book: false },
          ...(ctx.kind === "book"
            ? { activeByBook: { ...s.activeByBook, [ctx.bookId]: id } }
            : { activeLibraryConversation: id }),
        }));
      },
      restoreConversation: (ctx, id) =>
        set((s) => ({
          openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
          summaryChips: { chapter: false, book: false },
          ...(ctx.kind === "book"
            ? { activeByBook: { ...s.activeByBook, [ctx.bookId]: id } }
            : { activeLibraryConversation: id }),
        })),
      setSummaryChip: (kind, on) =>
        set((s) => ({ summaryChips: { ...s.summaryChips, [kind]: on } })),
      setSummaryChipsPreset: () => set({ summaryChips: { chapter: true, book: true } }),
      resetSummaryChips: () => set({ summaryChips: { chapter: false, book: false } }),
      resetForBookSwitch: () => set({ openCommand: null }),
    }),
    {
      name: "marginalia-chat",
      storage: safeStorage,
      partialize: (s) => ({
        activeByBook: s.activeByBook,
        activeLibraryConversation: s.activeLibraryConversation,
      }),
    },
  ),
);

/** 组件用：当前上下文的 active 会话（派生）。 */
export function useActiveConversationId(ctx: ChatContext): string | null {
  return useChatStore((s) =>
    ctx.kind === "book"
      ? (s.activeByBook[ctx.bookId] ?? null)
      : (s.activeLibraryConversation ?? null),
  );
}

/** action / transport 等非响应式语境用。 */
export function getActiveConversationId(ctx: ChatContext): string | null {
  const s = useChatStore.getState();
  return ctx.kind === "book"
    ? (s.activeByBook[ctx.bookId] ?? null)
    : (s.activeLibraryConversation ?? null);
}
