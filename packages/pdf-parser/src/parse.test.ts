import { describe, expect, it } from "vitest";
import { makeScannedPdf, makeTextPdf } from "./fixture";
import { parsePdf } from "./parse";

describe("parsePdf", () => {
  it("reads metadata, pageCount and detects text layer", async () => {
    const bytes = await makeTextPdf({ outline: false, title: "Fixture Book", author: "Tester" });
    const parsed = await parsePdf(bytes);
    expect(parsed.title).toBe("Fixture Book");
    expect(parsed.author).toBe("Tester");
    expect(parsed.pageCount).toBe(3);
    expect(parsed.hasTextLayer).toBe(true);
  });

  it("maps outline to flat toc + chapterRanges", async () => {
    const bytes = await makeTextPdf({ outline: true });
    const parsed = await parsePdf(bytes);
    expect(parsed.toc).toEqual([
      { label: "Chapter One", href: "pdf-ch:0" },
      { label: "Chapter Two", href: "pdf-ch:1" },
    ]);
    // Chapter One: p1–p2（下一章起点-1）；Chapter Two: p3–末页
    expect(parsed.chapterRanges).toEqual([
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 3 },
    ]);
  });

  it("falls back to single whole-book chapter when no outline", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const parsed = await parsePdf(bytes);
    expect(parsed.toc).toEqual([]);
    expect(parsed.chapterRanges).toEqual([{ startPage: 1, endPage: 3 }]);
  });

  it("detects scanned pdf (no text layer)", async () => {
    const bytes = await makeScannedPdf();
    const parsed = await parsePdf(bytes);
    expect(parsed.hasTextLayer).toBe(false);
  });
});
