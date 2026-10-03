import { describe, expect, it } from "vitest";
import {
  initialReadingPositionState,
  reduceReadingPosition,
  type ReadingPosition,
  type ReadingPositionState,
} from "./reading-position-machine";

const position: ReadingPosition = {
  index: 12,
  scrollRatio: 0.25,
  cfi: "epubcfi(/6/24!/4/2/2[p3])",
  percent: 0.31,
  chapterId: "ch-7",
  chapterTitle: "第七章",
  offset: 480,
};

const ready = { type: "SESSION_READY", locator: "epubcfi(/6/24!/4)", targetIndex: 11 } as const;

/** 走到 following：开书 → 恢复 → 收敛完成。 */
function following(): ReadingPositionState {
  const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
  return reduceReadingPosition(restoring, { type: "RESTORE_FINISHED", result: "settled" }).next;
}

describe("reduceReadingPosition", () => {
  it("enters restoring with a stored locator", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), ready);
    expect(next).toEqual({
      kind: "restoring",
      targetIndex: 11,
      locator: "epubcfi(/6/24!/4)",
    });
    expect(effects).toEqual([
      { kind: "restoreToCfi", locator: "epubcfi(/6/24!/4)", targetIndex: 11 },
    ]);
  });

  it("goes straight to following when there is nothing to restore", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), {
      type: "SESSION_READY",
      locator: null,
      targetIndex: null,
    });
    expect(next).toEqual({ kind: "following", last: null });
    expect(effects).toEqual([]);
  });

  it("goes to following when the stored locator resolves to no section", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), {
      type: "SESSION_READY",
      locator: "epubcfi(/6/999!/4)",
      targetIndex: null,
    });
    expect(next).toEqual({ kind: "following", last: null });
    expect(effects).toEqual([]);
  });

  it("ignores a repeated session-ready once past loading", () => {
    const state = following();
    const { next, effects } = reduceReadingPosition(state, ready);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("leaves restoring on every alignment outcome", () => {
    for (const result of ["settled", "timeout", "cancelled"] as const) {
      const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
      const { next } = reduceReadingPosition(restoring, { type: "RESTORE_FINISHED", result });
      // 恢复结束即以恢复目标为锚：还没滚动就重排时也有处可回。
      expect(next).toEqual({ kind: "following", last: { cfi: "epubcfi(/6/24!/4)", index: 11 } });
    }
  });

  it("persists progress only once following", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const during = reduceReadingPosition(restoring, { type: "TOP_SECTION_CHANGED", position });
    expect(during.effects).toEqual([{ kind: "reportPosition", position }]);

    const after = reduceReadingPosition(following(), { type: "TOP_SECTION_CHANGED", position });
    expect(after.effects).toEqual([
      { kind: "reportPosition", position },
      { kind: "persistProgress", position },
    ]);
  });

  it("resumes persistence after an alignment timeout", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const timedOut = reduceReadingPosition(restoring, {
      type: "RESTORE_FINISHED",
      result: "timeout",
    }).next;
    const { effects } = reduceReadingPosition(timedOut, { type: "TOP_SECTION_CHANGED", position });
    expect(effects).toContainEqual({ kind: "persistProgress", position });
  });

  it("hands control to the user mid-restore", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const { next } = reduceReadingPosition(restoring, { type: "USER_NAVIGATED" });
    expect(next).toEqual({ kind: "following", last: { cfi: "epubcfi(/6/24!/4)", index: 11 } });
  });

  it("ignores navigation requests while loading", () => {
    const loading = initialReadingPositionState();
    expect(
      reduceReadingPosition(loading, { type: "CHAPTER_REQUESTED", chapterId: "ch-2" }),
    ).toEqual({ next: loading, effects: [] });
    expect(
      reduceReadingPosition(loading, { type: "ANNOTATION_SCROLL", locator: "epubcfi(/6/8!/4)" }),
    ).toEqual({ next: loading, effects: [] });
    expect(reduceReadingPosition(loading, { type: "USER_NAVIGATED" })).toEqual({
      next: loading,
      effects: [],
    });
  });

  it("abandons an in-flight restore when a chapter jump is requested", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const { next, effects } = reduceReadingPosition(restoring, {
      type: "CHAPTER_REQUESTED",
      chapterId: "ch-2",
    });
    expect(next).toEqual({ kind: "following", last: null });
    expect(effects).toEqual([
      { kind: "notifyUserNavigation" },
      { kind: "scrollToChapter", chapterId: "ch-2" },
    ]);
  });

  it("scrolls to an annotation without leaving following", () => {
    const { next, effects } = reduceReadingPosition(following(), {
      type: "ANNOTATION_SCROLL",
      locator: "epubcfi(/6/8!/4/2)",
    });
    expect(next).toEqual({ kind: "following", last: null });
    expect(effects).toEqual([
      { kind: "notifyUserNavigation" },
      { kind: "scrollToAnnotation", locator: "epubcfi(/6/8!/4/2)" },
    ]);
  });

  it("jumps to a search hit, abandoning an in-flight restore", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const hit = { href: "text/ch2.xhtml", occurrence: 3, query: "margin" };
    const { next, effects } = reduceReadingPosition(restoring, {
      type: "SEARCH_HIT_REQUESTED",
      ...hit,
    });
    expect(next).toEqual({ kind: "following", last: null });
    expect(effects).toEqual([
      { kind: "notifyUserNavigation" },
      { kind: "scrollToSearchHit", ...hit },
    ]);
  });

  it("ignores a search hit jump while the book is still loading", () => {
    const loading = initialReadingPositionState();
    expect(
      reduceReadingPosition(loading, {
        type: "SEARCH_HIT_REQUESTED",
        href: "a.xhtml",
        occurrence: 0,
        query: "x",
      }),
    ).toEqual({ next: loading, effects: [] });
  });

  it("returns to loading when the book changes", () => {
    const { next, effects } = reduceReadingPosition(following(), { type: "BOOK_CHANGED" });
    expect(next).toEqual({ kind: "loading" });
    expect(effects).toEqual([]);
  });
});

describe("re-anchoring after reflow", () => {
  const reading = () =>
    reduceReadingPosition(following(), { type: "TOP_SECTION_CHANGED", position }).next;

  it("remembers the last position while following", () => {
    expect(reading()).toEqual({
      kind: "following",
      last: { cfi: position.cfi, index: position.index },
    });
  });

  it("keeps the previous anchor when the new position has no CFI", () => {
    const blank = { ...position, index: 13, cfi: null };
    const { next } = reduceReadingPosition(reading(), {
      type: "TOP_SECTION_CHANGED",
      position: blank,
    });
    expect(next).toEqual(reading());
  });

  it("re-aligns to the pre-reflow position without persisting the transients", () => {
    const { next, effects } = reduceReadingPosition(reading(), { type: "REFLOWED" });
    expect(next).toEqual({ kind: "restoring", targetIndex: 12, locator: position.cfi });
    expect(effects).toEqual([{ kind: "restoreToCfi", locator: position.cfi, targetIndex: 12 }]);

    // 重排途中视口顶报来的中间位置：只上报、不存盘、不改目标。
    const transient = { ...position, index: 40, cfi: "epubcfi(/6/82!/4/2)" };
    const during = reduceReadingPosition(next, {
      type: "TOP_SECTION_CHANGED",
      position: transient,
    });
    expect(during.next).toBe(next);
    expect(during.effects).toEqual([{ kind: "reportPosition", position: transient }]);
  });

  it("lets the in-flight alignment absorb a reflow during restore", () => {
    // 收敛逐 tick 重测目标元素；重发会让上一轮以 cancelled 收场、提前结束 restoring。
    const restoring = reduceReadingPosition(reading(), { type: "REFLOWED" }).next;
    const { next, effects } = reduceReadingPosition(restoring, { type: "REFLOWED" });
    expect(next).toBe(restoring);
    expect(effects).toEqual([]);
  });

  it("returns to following anchored at the target once re-aligned", () => {
    const restoring = reduceReadingPosition(reading(), { type: "REFLOWED" }).next;
    const { next } = reduceReadingPosition(restoring, {
      type: "RESTORE_FINISHED",
      result: "settled",
    });
    expect(next).toEqual(reading());
  });

  it("ignores a reflow before any position is known", () => {
    const loading = initialReadingPositionState();
    expect(reduceReadingPosition(loading, { type: "REFLOWED" })).toEqual({
      next: loading,
      effects: [],
    });
    const jumped = reduceReadingPosition(following(), {
      type: "CHAPTER_REQUESTED",
      chapterId: "ch-2",
    }).next;
    expect(reduceReadingPosition(jumped, { type: "REFLOWED" })).toEqual({
      next: jumped,
      effects: [],
    });
  });
});
