import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, CHAT_INITIAL, getActiveConversationId } from "@renderer/store/chat-store";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import { contextKey } from "@renderer/ai/chat-context";
import type { Chip } from "@shared/chat";

const BOOK = "book-1";
const BOOK_CTX = { kind: "book" as const, bookId: BOOK };
const LIB_CTX = { kind: "library" as const };

beforeEach(() => {
  useChatStore.setState(CHAT_INITIAL);
  usePrefsStore.setState(PREFS_INITIAL);
  // active 派生 + 记忆槽依赖 currentBookId，测试默认置于某本书的 reader 态
  useNavigationStore.setState({ ...NAVIGATION_INITIAL, view: "book", currentBookId: BOOK });
});

describe("chat-store: active = activeByBook 派生", () => {
  it("setActiveConversation writes the current book's slot", () => {
    useChatStore.getState().setActiveConversation(BOOK_CTX, "conv1");
    expect(useChatStore.getState().activeByBook[BOOK]).toBe("conv1");
    expect(getActiveConversationId(BOOK_CTX)).toBe("conv1");
  });
  it("setActiveConversation(null) clears slot and openCommand", () => {
    useChatStore.getState().openConversation(BOOK_CTX, "c1"); // 设 openCommand + 槽
    useChatStore.getState().setActiveConversation(BOOK_CTX, null);
    expect(useChatStore.getState().activeByBook[BOOK]).toBeNull();
    expect(useChatStore.getState().openCommand).toBeNull();
    expect(getActiveConversationId(BOOK_CTX)).toBeNull();
  });
  it("getActiveConversationId is null when book not in activeByBook", () => {
    // A book context with no entry → null
    expect(getActiveConversationId({ kind: "book", bookId: "no-such-book" })).toBeNull();
  });
  it("library context returns activeLibraryConversation", () => {
    useChatStore.getState().setActiveConversation(LIB_CTX, "lib-conv");
    expect(getActiveConversationId(LIB_CTX)).toBe("lib-conv");
  });
  it("setDraftText / setDraftChips update drafts", () => {
    useChatStore.getState().setDraftText("hi");
    const chip: Chip = {
      id: "selection",
      labelKey: "",
      content: "",
      tokenCount: 0,
      state: "required",
    };
    useChatStore.getState().setDraftChips([chip]);
    expect(useChatStore.getState().draftText).toBe("hi");
    expect(useChatStore.getState().draftChips).toHaveLength(1);
  });
});

describe("openConversation", () => {
  it("writes slot + opens panel + bumps openCommand nonce", () => {
    useChatStore.getState().openConversation(BOOK_CTX, "conv-1");
    expect(getActiveConversationId(BOOK_CTX)).toBe("conv-1");
    expect(usePrefsStore.getState().layout.panelOpen).toBe(true);
    expect(useChatStore.getState().openCommand).toEqual({
      conversationId: "conv-1",
      context: BOOK_CTX,
      nonce: 1,
    });
    useChatStore.getState().openConversation(BOOK_CTX, "conv-1");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2); // 同会话重开也递增 → 触发重载
  });
  it("resets summaryChips to off when opening existing conversation", () => {
    useChatStore.getState().setSummaryChipsPreset();
    useChatStore.getState().openConversation(BOOK_CTX, "conv-1");
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
  it("tags openCommand with the library context so it can't leak into a book panel", () => {
    useChatStore.getState().openConversation(LIB_CTX, "lib-conv");
    expect(useChatStore.getState().openCommand?.context).toEqual(LIB_CTX);
    // 守卫拒绝把 library 命令喂给某本书的面板，反向亦然
    expect(contextKey(useChatStore.getState().openCommand!.context)).toBe(contextKey(LIB_CTX));
  });
});

describe("restoreConversation", () => {
  it("writes slot + bumps openCommand nonce + does NOT open panel", () => {
    useChatStore.getState().restoreConversation(BOOK_CTX, "conv-restore");
    expect(getActiveConversationId(BOOK_CTX)).toBe("conv-restore");
    expect(useChatStore.getState().openCommand).toEqual({
      conversationId: "conv-restore",
      context: BOOK_CTX,
      nonce: 1,
    });
    expect(usePrefsStore.getState().layout.panelOpen).toBe(false);
  });
  it("bumps nonce on repeated restoreConversation", () => {
    useChatStore.getState().restoreConversation(BOOK_CTX, "conv-restore");
    useChatStore.getState().restoreConversation(BOOK_CTX, "conv-restore");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2);
  });
});

describe("resetForBookSwitch", () => {
  it("clears openCommand but keeps activeByBook and drafts", () => {
    useChatStore.getState().openConversation(BOOK_CTX, "conv-a"); // 设 openCommand + 槽
    useChatStore.getState().setDraftText("draft kept");
    useChatStore.getState().resetForBookSwitch();
    const s = useChatStore.getState();
    expect(s.openCommand).toBeNull();
    expect(s.activeByBook[BOOK]).toBe("conv-a"); // 记忆保留
    expect(s.draftText).toBe("draft kept"); // 草稿不清（跨卸载存活）
  });
});

describe("summaryChips state machine", () => {
  it("defaults to off, presets both on, resets to off", () => {
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
    useChatStore.getState().setSummaryChipsPreset();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: true, book: true });
    useChatStore.getState().resetSummaryChips();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
  it("toggles a single kind", () => {
    useChatStore.getState().setSummaryChip("chapter", true);
    expect(useChatStore.getState().summaryChips.chapter).toBe(true);
    expect(useChatStore.getState().summaryChips.book).toBe(false);
  });
});

describe("persist", () => {
  it("partialize persists activeByBook and activeLibraryConversation", () => {
    useChatStore.setState({
      activeByBook: { b: "c" },
      activeLibraryConversation: "lib-c",
      draftText: "x",
    });
    const partial = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
    expect(partial).toEqual({ activeByBook: { b: "c" }, activeLibraryConversation: "lib-c" });
  });
  it("rehydrates activeByBook from storage", () => {
    const store: Record<string, string> = {
      "marginalia-chat": JSON.stringify({ state: { activeByBook: { b9: "c9" } }, version: 0 }),
    };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    void useChatStore.persist.rehydrate();
    expect(useChatStore.getState().activeByBook).toEqual({ b9: "c9" });
    vi.unstubAllGlobals();
  });
});

describe("chat-store context-aware active conversation", () => {
  it("book context writes activeByBook; library writes activeLibraryConversation", () => {
    const s = useChatStore.getState();
    s.setActiveConversation({ kind: "book", bookId: "b1" }, "c-book");
    s.setActiveConversation({ kind: "library" }, "c-lib");
    const st = useChatStore.getState();
    expect(st.activeByBook["b1"]).toBe("c-book");
    expect(st.activeLibraryConversation).toBe("c-lib");
    expect(getActiveConversationId({ kind: "book", bookId: "b1" })).toBe("c-book");
    expect(getActiveConversationId({ kind: "library" })).toBe("c-lib");
  });

  it("contextKey produces stable namespaced keys", () => {
    expect(contextKey({ kind: "book", bookId: "b1" })).toBe("book:b1");
    expect(contextKey({ kind: "library" })).toBe("library");
  });
});
