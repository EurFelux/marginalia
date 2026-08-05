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
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([]);
  });

  it("goes to following when the stored locator resolves to no section", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), {
      type: "SESSION_READY",
      locator: "epubcfi(/6/999!/4)",
      targetIndex: null,
    });
    expect(next).toEqual({ kind: "following" });
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
      expect(next).toEqual({ kind: "following" });
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
    expect(next).toEqual({ kind: "following" });
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
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([
      { kind: "notifyTtsUserNavigation" },
      { kind: "scrollToChapter", chapterId: "ch-2" },
    ]);
  });

  it("scrolls to an annotation without leaving following", () => {
    const { next, effects } = reduceReadingPosition(following(), {
      type: "ANNOTATION_SCROLL",
      locator: "epubcfi(/6/8!/4/2)",
    });
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([
      { kind: "notifyTtsUserNavigation" },
      { kind: "scrollToAnnotation", locator: "epubcfi(/6/8!/4/2)" },
    ]);
  });

  it("returns to loading when the book changes", () => {
    const { next, effects } = reduceReadingPosition(following(), { type: "BOOK_CHANGED" });
    expect(next).toEqual({ kind: "loading" });
    expect(effects).toEqual([]);
  });
});
