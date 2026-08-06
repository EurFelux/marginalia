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
  // smooth 会分帧滚动，途中每一帧都派发 scroll 事件；起始几帧的 scrollTop 仍在「接近顶部」的
  // 阈值内，会误触发无限列表的上翻加载，而其锚点恢复又直接写 scrollTop、把动画取消在半途——
  // 首屏因此既多加载一页、又永远到不了底。一次到位不产生中间帧，两个症状同时消失。
  it("jumps instantly so the one-shot history render never lands near the top", () => {
    expect(conversationOpenScrollBehavior()).toBe("instant");
  });
});
