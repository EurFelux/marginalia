import { describe, expect, it } from "vitest";
import {
  conversationOpenScrollBehavior,
  isScrollAtBottom,
  messageScrollBehavior,
} from "./scroll-follow";

const streamingUpdate = {
  openingConversation: false,
  previousLength: 2,
  prependedHistory: false,
  lastMessageChanged: false,
  streamingAssistant: true,
};

describe("isScrollAtBottom", () => {
  it("accepts the bottom and measurements within four pixels", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 596.25, clientHeight: 400 })).toBe(
      true,
    );
  });

  it("does not treat a position outside the tolerance as the bottom", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 595.9, clientHeight: 400 })).toBe(
      false,
    );
  });
});

describe("messageScrollBehavior", () => {
  it("uses instant scrolling for an allowed streaming chunk", () => {
    expect(messageScrollBehavior({ ...streamingUpdate, following: true })).toBe("instant");
  });

  it("does not scroll after the viewport leaves the bottom", () => {
    expect(messageScrollBehavior({ ...streamingUpdate, following: false })).toBe(null);
  });

  it("defers scrolling while an existing conversation is opening", () => {
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: true,
        openingConversation: true,
        lastMessageChanged: true,
      }),
    ).toBe(null);
  });

  it("resumes instant scrolling after the viewport reaches the bottom", () => {
    const away = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 });
    expect(messageScrollBehavior({ ...streamingUpdate, following: away })).toBe(null);

    const bottom = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 });
    expect(messageScrollBehavior({ ...streamingUpdate, following: bottom })).toBe("instant");
  });

  it("never scrolls for initial loads or prepended history", () => {
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: true,
        previousLength: 0,
      }),
    ).toBe(null);
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: true,
        prependedHistory: true,
      }),
    ).toBe(null);
  });

  it("requires follow state for a newly appended assistant message too", () => {
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: false,
        lastMessageChanged: true,
      }),
    ).toBe(null);
  });
});

describe("conversationOpenScrollBehavior", () => {
  it("uses smooth scrolling for the one-shot history render", () => {
    expect(conversationOpenScrollBehavior()).toBe("smooth");
  });
});
