import { beforeEach, describe, expect, it } from "vitest";
import { useReaderStore, READER_INITIAL } from "@renderer/store/reader-store";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";

// zustand v5: replace=true 会覆盖 actions；用合并式重置只覆盖 state 字段
beforeEach(() => {
  useReaderStore.setState(READER_INITIAL);
  useChatStore.setState(CHAT_INITIAL);
});

describe("reader-store", () => {
  it("openBook switches to reader view with ids", () => {
    useReaderStore.getState().openBook("b1", "c1");
    const s = useReaderStore.getState();
    expect(s.view).toBe("reader");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBe("c1");
  });
  it("backToLibrary resets view", () => {
    useReaderStore.getState().openBook("b1", "c1");
    useReaderStore.getState().backToLibrary();
    expect(useReaderStore.getState().view).toBe("library");
  });
  it("updatePrefs merges", () => {
    useReaderStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(useReaderStore.getState().prefs.fontScale).toBe(1.2);
    expect(useReaderStore.getState().prefs.maxWidth).toBe(READER_INITIAL.prefs.maxWidth);
  });
  it("openBook with only bookId leaves currentChapterId null", () => {
    useReaderStore.getState().openBook("b1");
    const s = useReaderStore.getState();
    expect(s.view).toBe("reader");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBeNull();
  });
  it("openBook clears activeConversationId in chat-store", () => {
    useChatStore.getState().setActiveConversation("old-conv");
    useReaderStore.getState().openBook("b1", "c1");
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});
