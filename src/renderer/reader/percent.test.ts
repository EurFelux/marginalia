import { describe, expect, it } from "vitest";
import { epubPercent, pdfPercent } from "./percent";

describe("epubPercent", () => {
  it("interpolates spine index + in-section ratio", () => {
    expect(epubPercent(0, 0, 10)).toBe(0);
    expect(epubPercent(5, 0.5, 10)).toBe(0.55);
    expect(epubPercent(9, 1, 10)).toBe(1);
  });
  it("clamps degenerate inputs", () => {
    expect(epubPercent(0, 0, 0)).toBe(0); // sectionCount 0 防除零
    expect(epubPercent(12, 0.5, 10)).toBe(1); // 越界收敛
    expect(epubPercent(0, -0.5, 10)).toBe(0);
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
