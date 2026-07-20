import { describe, expect, it } from "vitest";
import {
  calibratedEstimate,
  deferBeforeLoadedIndex,
  estimateHeight,
  loadedFromIndexAfterNavigation,
  loadedFromIndexAfterVisibleTop,
  sectionScrollRatio,
  sectionsToUnload,
  topVisibleIndex,
} from "./precision";

describe("deferred section loading", () => {
  it("keeps sections before the active navigation target deferred", () => {
    expect(deferBeforeLoadedIndex(8, 7)).toBe(true);
    expect(deferBeforeLoadedIndex(8, 8)).toBe(false);
    expect(deferBeforeLoadedIndex(0, 0)).toBe(false);
  });

  it("opens loading only as far back as imperative navigation requires", () => {
    expect(loadedFromIndexAfterNavigation(8, 6)).toBe(6);
    expect(loadedFromIndexAfterNavigation(8, 10)).toBe(8);
    expect(loadedFromIndexAfterNavigation(6, 4)).toBe(4);
  });

  it("does not open deferred sections for a click, then opens them gradually while scrolling", () => {
    expect(loadedFromIndexAfterVisibleTop(8, 5, false)).toBe(8);
    expect(loadedFromIndexAfterVisibleTop(8, 8, true)).toBe(8);
    expect(loadedFromIndexAfterVisibleTop(8, 7, true)).toBe(7);
    expect(loadedFromIndexAfterVisibleTop(5, 7, true)).toBe(5);
  });
});

describe("estimateHeight", () => {
  it("returns cached height when present", () => {
    const cache = new Map([[3, 742]]);
    expect(estimateHeight(cache, 3, 600)).toBe(742);
  });
  it("falls back to the default estimate when uncached", () => {
    expect(estimateHeight(new Map(), 3, 600)).toBe(600);
  });
});

describe("calibratedEstimate", () => {
  it("returns cached height when present (weight ignored)", () => {
    const cache = new Map([[3, 742]]);
    expect(calibratedEstimate(cache, () => 9999, 3, 600)).toBe(742);
  });
  it("falls back to default when no weight function is given", () => {
    const cache = new Map([[0, 5000]]);
    expect(calibratedEstimate(cache, undefined, 3, 600)).toBe(600);
  });
  it("falls back to default when nothing has been measured yet", () => {
    expect(calibratedEstimate(new Map(), () => 1000, 3, 600)).toBe(600);
  });
  it("uses a conservative initial weight ratio before the first measurement", () => {
    const weights = new Map([
      [2, 1000],
      [3, 100_000],
    ]);
    const weightOf = (i: number) => weights.get(i) ?? 0;
    expect(calibratedEstimate(new Map(), weightOf, 2, 600, 0.1)).toBe(600);
    expect(calibratedEstimate(new Map(), weightOf, 3, 600, 0.1)).toBe(10_000);
  });
  it("scales the estimate by measured px-per-weight", () => {
    // section 0 measured 5000px at weight 1000 → 5 px/unit; target weight 2000 → 10000px
    const cache = new Map([[0, 5000]]);
    const weights = new Map([
      [0, 1000],
      [5, 2000],
    ]);
    expect(calibratedEstimate(cache, (i) => weights.get(i) ?? 0, 5, 600)).toBe(10000);
  });
  it("falls back to default for zero-weight targets (image-only sections)", () => {
    const cache = new Map([[0, 5000]]);
    const weights = new Map([
      [0, 1000],
      [5, 0],
    ]);
    expect(calibratedEstimate(cache, (i) => weights.get(i) ?? 0, 5, 600)).toBe(600);
  });
  it("excludes zero-weight sections from calibration", () => {
    // idx0 is a 400px cover (weight 0) — must not poison the ratio; idx1: 6000px @ 1000 → 6 px/unit
    const cache = new Map([
      [0, 400],
      [1, 6000],
    ]);
    const weights = new Map([
      [0, 0],
      [1, 1000],
      [2, 500],
    ]);
    expect(calibratedEstimate(cache, (i) => weights.get(i) ?? 0, 2, 600)).toBe(3000);
  });
  it("pools all measured sections into one ratio", () => {
    // (4000+8000)px / (1000+3000)w = 3 px/unit; target weight 2000 → 6000
    const cache = new Map([
      [0, 4000],
      [1, 8000],
    ]);
    const weights = new Map([
      [0, 1000],
      [1, 3000],
      [7, 2000],
    ]);
    expect(calibratedEstimate(cache, (i) => weights.get(i) ?? 0, 7, 600)).toBe(6000);
  });
});

describe("sectionsToUnload", () => {
  it("keeps the active range plus keepDistance on both sides", () => {
    // total 20, range [8,10], keepDistance 2 → keep [6..12], unload rest
    const out = sectionsToUnload({ startIndex: 8, endIndex: 10 }, 20, 2);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 13, 14, 15, 16, 17, 18, 19]);
  });
  it("returns empty when the whole book is within keepDistance", () => {
    expect(sectionsToUnload({ startIndex: 0, endIndex: 4 }, 5, 2)).toEqual([]);
  });
  it("clamps at boundaries (no negative / out-of-range indices)", () => {
    expect(sectionsToUnload({ startIndex: 0, endIndex: 0 }, 4, 1)).toEqual([2, 3]);
  });
});

describe("topVisibleIndex", () => {
  const vt = 100; // viewport top line
  it("returns null for empty input", () => {
    expect(topVisibleIndex([], vt)).toBeNull();
  });
  it("picks the section straddling the viewport-top line", () => {
    const secs = [
      { index: 0, top: 0, bottom: 90 },
      { index: 1, top: 90, bottom: 300 }, // contains 100
      { index: 2, top: 300, bottom: 500 },
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
  it("on a gap, picks the nearest section below the line", () => {
    const secs = [
      { index: 0, top: 0, bottom: 80 },
      { index: 1, top: 120, bottom: 300 }, // first with top >= 100
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
  it("when all sections are above the line, picks the lowest (max bottom)", () => {
    const secs = [
      { index: 0, top: -200, bottom: -50 },
      { index: 1, top: -100, bottom: 20 }, // max bottom
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
});

describe("sectionScrollRatio", () => {
  it("returns the viewport top position within the section", () => {
    expect(sectionScrollRatio({ top: 100, bottom: 300 }, 150)).toBe(0.25);
  });

  it("clamps outside values", () => {
    expect(sectionScrollRatio({ top: 100, bottom: 300 }, 50)).toBe(0);
    expect(sectionScrollRatio({ top: 100, bottom: 300 }, 400)).toBe(1);
  });
});
