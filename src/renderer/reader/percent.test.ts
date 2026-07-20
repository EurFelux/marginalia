import { describe, expect, it } from "vitest";
import { epubPercent, pdfPercent } from "./percent";

describe("epubPercent", () => {
  it("weights the current text offset by readable text across the book", () => {
    expect(epubPercent(0, 5, [10, 90], 0)).toBe(0.05);
    expect(epubPercent(1, 45, [10, 90], 0)).toBe(0.55);
  });

  it("gives zero-text spine items no artificial weight", () => {
    expect(epubPercent(0, 0, [0, 100, 0], 0.5)).toBe(0);
    expect(epubPercent(1, 50, [0, 100, 0], 0)).toBe(0.5);
    expect(epubPercent(2, 0, [0, 100, 0], 0)).toBe(1);
  });

  it("uses the section scroll ratio when no text offset is available", () => {
    expect(epubPercent(1, null, [10, 90], 0.5)).toBe(0.55);
  });

  it("falls back to spine interpolation when the profile has no readable text", () => {
    expect(epubPercent(0, null, [], 0.5)).toBe(0);
    expect(epubPercent(1, null, [0, 0], 0.5)).toBe(0.75);
  });

  it("clamps malformed positions and weights", () => {
    expect(epubPercent(-1, -5, [10, 90], -1)).toBe(0);
    expect(epubPercent(12, 10, [10, 90], 0.5)).toBe(1);
    expect(epubPercent(1, 200, [10, Number.NaN], 2)).toBe(1);
  });
});

describe("pdfPercent", () => {
  it("is page / pageCount", () => {
    expect(pdfPercent(1, 4)).toBe(0.25);
    expect(pdfPercent(304, 304)).toBe(1);
  });
  it("clamps degenerate inputs", () => {
    expect(pdfPercent(1, 0)).toBe(0); // pageCount 0 防除零
    expect(pdfPercent(5, 4)).toBe(1);
  });
});
