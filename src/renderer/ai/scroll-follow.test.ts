import { describe, expect, it } from "vitest";
import { isScrollAtBottom, shouldScrollToBottom } from "./scroll-follow";

const streamingUpdate = {
  previousLength: 2,
  prependedHistory: false,
  lastMessageChanged: false,
  streamingAssistant: true,
};

describe("isScrollAtBottom", () => {
  it("accepts the bottom and fractional measurements within one pixel", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 599.25, clientHeight: 400 })).toBe(
      true,
    );
  });

  it("does not treat a merely near-bottom viewport as the bottom", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 598.9, clientHeight: 400 })).toBe(
      false,
    );
  });
});

describe("shouldScrollToBottom", () => {
  it("follows a streaming chunk only while bottom following is enabled", () => {
    expect(shouldScrollToBottom({ ...streamingUpdate, following: true })).toBe(true);
    expect(shouldScrollToBottom({ ...streamingUpdate, following: false })).toBe(false);
  });

  it("resumes streaming follow only after the viewport reaches the bottom", () => {
    const away = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 });
    expect(shouldScrollToBottom({ ...streamingUpdate, following: away })).toBe(false);

    const bottom = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 });
    expect(shouldScrollToBottom({ ...streamingUpdate, following: bottom })).toBe(true);
  });

  it("never scrolls for initial loads or prepended history", () => {
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: true,
        previousLength: 0,
      }),
    ).toBe(false);
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: true,
        prependedHistory: true,
      }),
    ).toBe(false);
  });

  it("requires follow state for a newly appended assistant message too", () => {
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: false,
        lastMessageChanged: true,
      }),
    ).toBe(false);
  });
});
