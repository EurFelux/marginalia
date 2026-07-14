import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";

beforeEach(() => {
  useNavigationStore.setState(NAVIGATION_INITIAL);
  useChatStore.setState(CHAT_INITIAL);
});

describe("navigation-store", () => {
  it("openBook switches to book view in auto mode with ids", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    const s = useNavigationStore.getState();
    expect(s.view).toBe("book");
    expect(s.bookMode).toBe("auto");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBe("c1");
  });
  it("openBookReference sets reference mode", () => {
    useNavigationStore.getState().openBookReference("b1");
    expect(useNavigationStore.getState()).toMatchObject({
      view: "book",
      currentBookId: "b1",
      bookMode: "reference",
    });
  });
  it("openBook with only bookId leaves currentChapterId null", () => {
    useNavigationStore.getState().openBook("b1");
    expect(useNavigationStore.getState().currentChapterId).toBeNull();
  });
  it("backToLibrary resets view", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    useNavigationStore.getState().backToLibrary();
    expect(useNavigationStore.getState().view).toBe("library");
  });
  it("setCurrentChapter updates currentChapterId", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    useNavigationStore.getState().setCurrentChapter("c2");
    expect(useNavigationStore.getState().currentChapterId).toBe("c2");
  });
  it("showStats sets view to stats", () => {
    useNavigationStore.getState().showStats();
    expect(useNavigationStore.getState().view).toBe("stats");
  });
  it("showLibrary sets view to library", () => {
    useNavigationStore.setState({ view: "stats" });
    useNavigationStore.getState().showLibrary();
    expect(useNavigationStore.getState().view).toBe("library");
  });
  it("openBook clears stale openCommand but keeps per-book memory", () => {
    useChatStore.setState({
      activeByBook: { b2: "conv-b2" },
      openCommand: { conversationId: "stale", context: { kind: "book", bookId: "b9" }, nonce: 1 },
    });
    useNavigationStore.getState().openBook("b2");
    expect(useChatStore.getState().openCommand).toBeNull(); // 残留命令被清（修 bug）
    expect(useChatStore.getState().activeByBook.b2).toBe("conv-b2"); // 记忆保留
  });
});
