import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";

beforeEach(() => {
  useNavigationStore.setState(NAVIGATION_INITIAL);
  useChatStore.setState(CHAT_INITIAL);
});

describe("navigation-store", () => {
  it("openBook switches to reader view with ids", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    const s = useNavigationStore.getState();
    expect(s.view).toBe("reader");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBe("c1");
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
  it("openBook clears active conversation (cross-store coordination)", () => {
    useChatStore.getState().setActiveConversation("conv1");
    useNavigationStore.getState().openBook("b2");
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});
