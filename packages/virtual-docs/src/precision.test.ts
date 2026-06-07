import { describe, expect, it } from "vitest";
import { estimateHeight, sectionScrollRatio, sectionsToUnload, topVisibleIndex } from "./precision";

describe("estimateHeight", () => {
  it("returns cached height when present", () => {
    const cache = new Map([[3, 742]]);
    expect(estimateHeight(cache, 3, 600)).toBe(742);
  });
  it("falls back to the default estimate when uncached", () => {
    expect(estimateHeight(new Map(), 3, 600)).toBe(600);
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
