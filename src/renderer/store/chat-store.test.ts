import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";
import type { Chip } from "@shared/chat";

beforeEach(() => useChatStore.setState(CHAT_INITIAL));

describe("chat-store", () => {
  it("setActiveConversation stores id", () => {
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeConversationId).toBe("conv1");
  });
  it("setDraftText / setDraftChips update drafts", () => {
    useChatStore.getState().setDraftText("hi");
    const chip: Chip = {
      id: "selection",
      labelKey: "",
      content: "",
      tokenCount: 0,
      required: false,
      enabled: false,
    };
    useChatStore.getState().setDraftChips([chip]);
    expect(useChatStore.getState().draftText).toBe("hi");
    expect(useChatStore.getState().draftChips).toHaveLength(1);
  });
  it("setPanelOpen toggles", () => {
    useChatStore.getState().setPanelOpen(true);
    expect(useChatStore.getState().panelOpen).toBe(true);
  });
});
