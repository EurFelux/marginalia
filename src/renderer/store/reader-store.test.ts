import { beforeEach, describe, expect, it } from "vitest";
import { useReaderStore, READER_INITIAL } from "@renderer/store/reader-store";

// zustand v5: replace=true 会覆盖 actions；用合并式重置只覆盖 state 字段
beforeEach(() => useReaderStore.setState(READER_INITIAL));

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
  it("setActiveConversation stores id", () => {
    useReaderStore.getState().setActiveConversation("conv1");
    expect(useReaderStore.getState().activeConversationId).toBe("conv1");
  });
  it("updatePrefs merges", () => {
    useReaderStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(useReaderStore.getState().prefs.fontScale).toBe(1.2);
    expect(useReaderStore.getState().prefs.maxWidth).toBe(READER_INITIAL.prefs.maxWidth);
  });
});
