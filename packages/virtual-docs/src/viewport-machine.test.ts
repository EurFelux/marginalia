import { describe, expect, it } from "vitest";
import {
  ALIGN_MAX_ATTEMPTS,
  ALIGN_MINIMUM_ATTEMPTS,
  ALIGN_SUCCESSES_REQUIRED,
  initialViewportState,
  overscanTop,
  reduceViewport,
  type ViewportEvent,
  type ViewportState,
} from "./viewport-machine";

/** 连喂 n 个对齐结果一致的 tick，返回末态。 */
function tick(state: ViewportState, n: number, aligned: boolean): ViewportState {
  let s = state;
  for (let i = 0; i < n; i++) {
    if (s.phase.kind !== "aligning") break;
    s = reduceViewport(s, {
      type: "ALIGN_TICK",
      runId: s.phase.runId,
      aligned,
      offset: 120,
    }).next;
  }
  return s;
}

const align: ViewportEvent = { type: "ALIGN_REQUESTED", index: 40, owner: "restore" };

describe("reduceViewport", () => {
  it("starts a ticker and a section-level scroll when alignment is requested", () => {
    const { next, effects } = reduceViewport(initialViewportState(40), align);
    expect(next.phase).toMatchObject({ kind: "aligning", target: 40, owner: "restore" });
    expect(effects).toEqual([
      { kind: "scrollToIndex", index: 40 },
      { kind: "startTicker", runId: 1 },
    ]);
  });

  it("does not treat restoration as user navigation", () => {
    const { next } = reduceViewport(initialViewportState(40), align);
    expect(next.everUserNavigated).toBe(false);
  });

  it("settles only after the stability window and a full success streak", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    // 提前凑满 streak 也不能提前 settle：必须先跨过最小观察次数。
    const early = tick(started, ALIGN_SUCCESSES_REQUIRED, true);
    expect(early.phase.kind).toBe("aligning");

    const justBefore = tick(early, ALIGN_MINIMUM_ATTEMPTS - ALIGN_SUCCESSES_REQUIRED - 1, true);
    expect(justBefore.phase.kind).toBe("aligning");

    const last = reduceViewport(justBefore, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: true,
      offset: 0,
    });
    expect(last.next.phase.kind).toBe("systemOwned");
    expect(last.effects).toEqual([
      { kind: "stopTicker" },
      { kind: "reportAlignResult", result: "settled" },
      { kind: "recomputeTop" },
    ]);
  });

  it("resets the streak when an attempt misses", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    // 停在最小观察次数前一步：再喂一个对齐的 tick 就会 settle，故此处只能喂未对齐的。
    const hit = tick(started, ALIGN_MINIMUM_ATTEMPTS - 1, true);
    // 已跨过最小观察次数但中途未对齐 → streak 归零，不得 settle。
    const missed = reduceViewport(hit, { type: "ALIGN_TICK", runId: 1, aligned: false, offset: 5 });
    expect(missed.next.phase).toMatchObject({
      kind: "aligning",
      streak: 0,
      attempts: ALIGN_MINIMUM_ATTEMPTS,
    });
    expect(missed.effects).toEqual([{ kind: "scrollToIndex", index: 40, offset: 5 }]);
  });

  it("re-issues a section-level scroll when the element cannot be resolved", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { effects } = reduceViewport(started, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: false,
      offset: null,
    });
    expect(effects).toEqual([{ kind: "scrollToIndex", index: 40 }]);
  });

  it("reports a timeout after the attempt ceiling", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const exhausted = tick(started, ALIGN_MAX_ATTEMPTS, false);
    expect(exhausted.phase.kind).toBe("systemOwned");
    const last = tick(started, ALIGN_MAX_ATTEMPTS - 1, false);
    const final = reduceViewport(last, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: false,
      offset: null,
    });
    expect(final.effects).toContainEqual({ kind: "reportAlignResult", result: "timeout" });
  });

  it("ignores ticks from a superseded run", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const restarted = reduceViewport(started, {
      type: "ALIGN_REQUESTED",
      index: 7,
      owner: "user",
    }).next;
    const stale = reduceViewport(restarted, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: true,
      offset: 0,
    });
    expect(stale.next).toBe(restarted);
    expect(stale.effects).toEqual([]);
  });

  it("cancels the in-flight alignment when a new one is requested", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { effects } = reduceViewport(started, {
      type: "ALIGN_REQUESTED",
      index: 7,
      owner: "user",
    });
    expect(effects[0]).toEqual({ kind: "reportAlignResult", result: "cancelled" });
    expect(effects).toContainEqual({ kind: "stopTicker" });
  });

  it("hands the viewport to the user on scroll intent and cancels alignment", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { next, effects } = reduceViewport(started, {
      type: "USER_INPUT",
      scrollIntent: true,
    });
    expect(next.phase.kind).toBe("userOwned");
    expect(next.everUserNavigated).toBe(true);
    expect(effects).toContainEqual({ kind: "reportAlignResult", result: "cancelled" });
  });

  it("cancels alignment on a bare pointerdown without taking ownership", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { next, effects } = reduceViewport(started, {
      type: "USER_INPUT",
      scrollIntent: false,
    });
    expect(next.phase.kind).toBe("systemOwned");
    expect(next.everUserNavigated).toBe(false);
    expect(effects).toContainEqual({ kind: "reportAlignResult", result: "cancelled" });
  });

  it("advances the loaded frontier only while the user owns the viewport", () => {
    const initial = initialViewportState(40);
    const ignored = reduceViewport(initial, { type: "VISIBLE_TOP_CHANGED", index: 12 });
    expect(ignored.next.loadedFromIndex).toBe(40);

    const owned = reduceViewport(initial, { type: "USER_INPUT", scrollIntent: true }).next;
    const advanced = reduceViewport(owned, { type: "VISIBLE_TOP_CHANGED", index: 12 }).next;
    expect(advanced.loadedFromIndex).toBe(12);
  });

  it("never moves the loaded frontier forward", () => {
    const owned = reduceViewport(initialViewportState(40), {
      type: "USER_INPUT",
      scrollIntent: true,
    }).next;
    const back = reduceViewport(owned, { type: "VISIBLE_TOP_CHANGED", index: 12 }).next;
    const forward = reduceViewport(back, { type: "VISIBLE_TOP_CHANGED", index: 30 }).next;
    expect(forward.loadedFromIndex).toBe(12);
  });

  it("marks a command-level jump as user navigation", () => {
    const { next, effects } = reduceViewport(initialViewportState(40), {
      type: "JUMP_REQUESTED",
      index: 3,
    });
    expect(next.phase.kind).toBe("systemOwned");
    expect(next.everUserNavigated).toBe(true);
    expect(next.loadedFromIndex).toBe(3);
    expect(effects).toEqual([{ kind: "scrollToIndex", index: 3 }]);
  });

  it("derives overscan from the navigation latch", () => {
    const initial = initialViewportState(40);
    // 深处冷启、尚未发生过用户导航 → 顶部 overscan 强制为 0：上方 section 的迟到测高
    // 会推走恢复目标，此时不能预挂载。
    expect(overscanTop(initial, 40, 2400)).toBe(0);
    // 从头开书（initialIndex=0）没有「上方 section 推走目标」的风险，照常双向 overscan。
    expect(overscanTop(initial, 0, 2400)).toBe(2400);

    // 一旦发生过用户级导航（即使仍是深处冷启的 initialIndex），latch 永久翻转，恢复双向 overscan。
    const owned = reduceViewport(initial, { type: "USER_INPUT", scrollIntent: true }).next;
    expect(overscanTop(owned, 40, 2400)).toBe(2400);
  });
});
