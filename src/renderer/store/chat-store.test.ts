import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, CHAT_INITIAL, getActiveConversationId } from "@renderer/store/chat-store";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import type { Chip } from "@shared/chat";

const BOOK = "book-1";

beforeEach(() => {
  useChatStore.setState(CHAT_INITIAL);
  usePrefsStore.setState(PREFS_INITIAL);
  // active 派生 + rememberSlot 依赖 currentBookId，测试默认置于某本书的 reader 态
  useNavigationStore.setState({ ...NAVIGATION_INITIAL, view: "reader", currentBookId: BOOK });
});

describe("chat-store: active = activeByBook 派生", () => {
  it("setActiveConversation writes the current book's slot", () => {
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeByBook[BOOK]).toBe("conv1");
    expect(getActiveConversationId()).toBe("conv1");
  });
  it("setActiveConversation(null) clears slot and openCommand", () => {
    useChatStore.getState().openConversation("c1"); // 设 openCommand + 槽
    useChatStore.getState().setActiveConversation(null);
    expect(useChatStore.getState().activeByBook[BOOK]).toBeNull();
    expect(useChatStore.getState().openCommand).toBeNull();
    expect(getActiveConversationId()).toBeNull();
  });
  it("getActiveConversationId is null in library (no current book)", () => {
    useChatStore.getState().setActiveConversation("conv1");
    useNavigationStore.setState({ ...NAVIGATION_INITIAL }); // currentBookId=null
    expect(getActiveConversationId()).toBeNull();
  });
  it("setActiveConversation is a no-op on the slot when no current book", () => {
    useNavigationStore.setState({ ...NAVIGATION_INITIAL }); // currentBookId=null
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeByBook).toEqual({});
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
    useChatStore.getState().openConversation("conv-1");
    expect(getActiveConversationId()).toBe("conv-1");
    expect(usePrefsStore.getState().layout.panelOpen).toBe(true);
    expect(useChatStore.getState().openCommand).toEqual({ conversationId: "conv-1", nonce: 1 });
    useChatStore.getState().openConversation("conv-1");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2); // 同会话重开也递增 → 触发重载
  });
  it("resets summaryChips to off when opening existing conversation", () => {
    useChatStore.getState().setSummaryChipsPreset();
    useChatStore.getState().openConversation("conv-1");
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
});

describe("restoreConversation", () => {
  it("writes slot + bumps openCommand nonce + does NOT open panel", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    expect(getActiveConversationId()).toBe("conv-restore");
    expect(useChatStore.getState().openCommand).toEqual({
      conversationId: "conv-restore",
      nonce: 1,
    });
    expect(usePrefsStore.getState().layout.panelOpen).toBe(false);
  });
  it("bumps nonce on repeated restoreConversation", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    useChatStore.getState().restoreConversation("conv-restore");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2);
  });
});

describe("resetForBookSwitch", () => {
  it("clears openCommand but keeps activeByBook and drafts", () => {
    useChatStore.getState().openConversation("conv-a"); // 设 openCommand + 槽
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
  it("partialize persists only activeByBook", () => {
    useChatStore.setState({ activeByBook: { b: "c" }, draftText: "x" });
    const partial = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
    expect(partial).toEqual({ activeByBook: { b: "c" } });
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
