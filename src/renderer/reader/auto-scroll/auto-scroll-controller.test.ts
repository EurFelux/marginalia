import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@renderer/logger", () => ({ createLogger: () => log }));

import { PREFS_INITIAL, usePrefsStore } from "@renderer/store/prefs-store";
import { useAutoScrollStore } from "@renderer/store/auto-scroll-store";
import { autoScrollController } from "./auto-scroll-controller";

/** 最小滚动容器：浏览器把 scrollTop 夹在 [0, scrollHeight − clientHeight]；记下每次写入值。 */
class FakeScroller extends EventTarget {
  scrollHeight = 10_000;
  clientHeight = 800;
  writes: number[] = [];
  #top = 0;
  get scrollTop(): number {
    return this.#top;
  }
  set scrollTop(v: number) {
    this.writes.push(v);
    this.#top = Math.min(Math.max(0, v), this.scrollHeight - this.clientHeight);
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let now: number;

/** 推进 n 帧，默认每帧 16ms。 */
function runFrames(n: number, frameMs = 16): void {
  for (let i = 0; i < n; i++) {
    now += frameMs;
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(now);
  }
}

function setup(opts: { canClaimViewport?: () => boolean; claimViewport?: () => void } = {}) {
  const scroller = new FakeScroller();
  autoScrollController.attach({
    getScroller: () => scroller as unknown as HTMLElement,
    canClaimViewport: opts.canClaimViewport,
    claimViewport: opts.claimViewport,
  });
  return scroller;
}

const status = () => useAutoScrollStore.getState().status;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  usePrefsStore.setState(PREFS_INITIAL);
});

afterEach(() => {
  autoScrollController.detach();
  vi.unstubAllGlobals();
});

describe("autoScrollController", () => {
  it("scrolls at the level speed (10 = 1.0× = 10 px/s) in whole pixels", () => {
    const scroller = setup();
    scroller.scrollTop = 1000;
    autoScrollController.start();
    expect(status()).toBe("running");
    runFrames(1 + 125); // 首帧只取基准，随后 125 × 16ms = 2s
    expect(scroller.scrollTop).toBe(1020);
  });

  it("writes whole pixels with fractional frame timestamps, without drift", () => {
    const scroller = setup();
    autoScrollController.start();
    runFrames(1 + 600, 1000 / 60); // 60Hz 的小数时间戳，共 10s
    expect(scroller.writes.length).toBeGreaterThan(0);
    expect(scroller.writes.every(Number.isInteger)).toBe(true);
    expect(scroller.scrollTop).toBe(100);
  });

  it("picks up a speed change on the next frame", () => {
    const scroller = setup();
    autoScrollController.start();
    runFrames(1);
    usePrefsStore.setState({ autoScrollSpeed: 20 });
    runFrames(125);
    expect(scroller.scrollTop).toBe(40);
  });

  it("claims the viewport on the first frame after start and after resume", () => {
    const claimViewport = vi.fn();
    const scroller = setup({ claimViewport });
    autoScrollController.start();
    runFrames(3);
    expect(claimViewport).toHaveBeenCalledTimes(1);
    scroller.dispatchEvent(new Event("wheel"));
    autoScrollController.resume();
    runFrames(3);
    expect(claimViewport).toHaveBeenCalledTimes(2);
  });

  it("waits without scrolling until the viewport can be claimed", () => {
    let canClaim = false;
    const claimViewport = vi.fn();
    const scroller = setup({ canClaimViewport: () => canClaim, claimViewport });
    scroller.scrollTop = 1000;
    autoScrollController.start();
    expect(status()).toBe("running");
    runFrames(30);
    expect(claimViewport).not.toHaveBeenCalled();
    expect(scroller.writes).toEqual([1000]); // 只有测试自己的那次写入
    canClaim = true;
    runFrames(1 + 125);
    expect(claimViewport).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(1020);
  });

  it("does not mistake a transient scroll-end for the end of the book while waiting to claim", () => {
    // 开书恢复半途：列表总高仍是估算，视口被夹在底部。
    let canClaim = false;
    const scroller = setup({ canClaimViewport: () => canClaim });
    scroller.scrollTop = scroller.scrollHeight;
    autoScrollController.start();
    runFrames(10);
    expect(status()).toBe("running");
    // 恢复落位：真实高度到位，下方有内容了。
    scroller.scrollHeight += 5000;
    canClaim = true;
    runFrames(1 + 125);
    expect(status()).toBe("running");
    expect(scroller.scrollTop).toBe(9200 + 20);
  });

  it("stops at claim time if there is really nothing left to scroll", () => {
    let canClaim = false;
    const claimViewport = vi.fn();
    const scroller = setup({ canClaimViewport: () => canClaim, claimViewport });
    scroller.scrollTop = scroller.scrollHeight;
    autoScrollController.start();
    runFrames(5);
    canClaim = true;
    runFrames(1);
    expect(status()).toBe("idle");
    expect(claimViewport).not.toHaveBeenCalled();
  });

  it("can be paused by user input while waiting to claim", () => {
    const claimViewport = vi.fn();
    const scroller = setup({ canClaimViewport: () => false, claimViewport });
    autoScrollController.start();
    runFrames(5);
    scroller.dispatchEvent(new Event("pointerdown"));
    expect(status()).toBe("paused");
    expect(claimViewport).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it.each(["wheel", "touchstart", "keydown", "pointerdown"])(
    "pauses on %s on the scroller and stops moving",
    (type) => {
      const scroller = setup();
      autoScrollController.start();
      runFrames(10);
      scroller.dispatchEvent(new Event(type));
      expect(status()).toBe("paused");
      const at = scroller.scrollTop;
      runFrames(10);
      expect(scroller.scrollTop).toBe(at);
    },
  );

  it("ignores input on the scroller once paused or stopped", () => {
    const scroller = setup();
    autoScrollController.start();
    autoScrollController.stop();
    scroller.dispatchEvent(new Event("wheel"));
    expect(status()).toBe("idle");
  });

  it("resumes from the current position, not the position it paused at", () => {
    const scroller = setup();
    autoScrollController.start();
    runFrames(10);
    autoScrollController.notifyUserNavigation();
    expect(status()).toBe("paused");
    scroller.scrollTop = 5000; // 跳转去了别处
    autoScrollController.resume();
    runFrames(1 + 50);
    expect(scroller.scrollTop).toBe(5008);
  });

  it("stops at the end of the book", () => {
    const scroller = setup();
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 0.5;
    scroller.scrollHeight += 2; // 还差 2.5px
    autoScrollController.start();
    runFrames(1 + 20);
    expect(status()).toBe("idle");
    expect(frames.size).toBe(0);
  });

  it("does not start when there is nothing left to scroll", () => {
    const scroller = setup();
    scroller.scrollTop = scroller.scrollHeight;
    autoScrollController.start();
    expect(status()).toBe("idle");
    expect(frames.size).toBe(0);
  });

  it("stops instead of resuming when paused at the end", () => {
    const scroller = setup();
    autoScrollController.start();
    autoScrollController.pause();
    scroller.scrollTop = scroller.scrollHeight;
    autoScrollController.resume();
    expect(status()).toBe("idle");
  });

  it("stops and detaches its listeners when the reader detaches", () => {
    const scroller = setup();
    autoScrollController.start();
    autoScrollController.detach();
    expect(status()).toBe("idle");
    expect(frames.size).toBe(0);
    autoScrollController.start(); // 无上下文：不启动
    expect(status()).toBe("idle");
    expect(log.warn).toHaveBeenCalledWith("auto-scroll not started: scroller not ready");
    scroller.dispatchEvent(new Event("wheel"));
    expect(status()).toBe("idle");
  });
});
