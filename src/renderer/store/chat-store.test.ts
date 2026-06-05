import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import type { Chip } from "@shared/chat";

beforeEach(() => {
  useChatStore.setState(CHAT_INITIAL);
  usePrefsStore.setState(PREFS_INITIAL);
});

describe("chat-store", () => {
  it("setActiveConversation stores id", () => {
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeConversationId).toBe("conv1");
  });
  it("setActiveConversation(null) resets to null", () => {
    useChatStore.getState().setActiveConversation("c1");
    useChatStore.getState().setActiveConversation(null);
    expect(useChatStore.getState().activeConversationId).toBeNull();
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
  it("sets active + opens panel + bumps openCommand nonce", () => {
    useChatStore.getState().openConversation("conv-1");
    const s1 = useChatStore.getState();
    expect(s1.activeConversationId).toBe("conv-1");
    expect(usePrefsStore.getState().layout.panelOpen).toBe(true);
    expect(s1.openCommand).toEqual({ conversationId: "conv-1", nonce: 1 });
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
  it("sets active + bumps openCommand nonce + does NOT open panel", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    const s = useChatStore.getState();
    expect(s.activeConversationId).toBe("conv-restore");
    expect(s.openCommand).toEqual({ conversationId: "conv-restore", nonce: 1 });
    // 不强制开面板（与 openConversation 的区别）
    expect(usePrefsStore.getState().layout.panelOpen).toBe(false);
  });
  it("bumps nonce on repeated restoreConversation", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    useChatStore.getState().restoreConversation("conv-restore");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2);
  });
  it("resets summaryChips to off when restoring existing conversation", () => {
    useChatStore.getState().setSummaryChipsPreset();
    useChatStore.getState().restoreConversation("conv-restore");
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
});

describe("summaryChips state machine", () => {
  it("defaults to off, presets both on, resets to off", () => {
    const s = useChatStore.getState();
    expect(s.summaryChips).toEqual({ chapter: false, book: false });
    s.setSummaryChipsPreset();
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
