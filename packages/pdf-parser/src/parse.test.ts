import { describe, expect, it } from "vitest";
import { makeScannedPdf, makeTextPdf } from "./fixture";
import { openPdf, pageText, parsePdf } from "./parse";

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

  it("returns undefined title/author when metadata absent", async () => {
    const parsed = await parsePdf(await makeTextPdf({ outline: false }));
    expect(parsed.title).toBeUndefined();
    expect(parsed.author).toBeUndefined();
  });

  it("pageText extracts a single page's text", async () => {
    const doc = await openPdf(await makeTextPdf({ outline: false }));
    try {
      const text = await pageText(doc, 2);
      expect(text).toContain("body text of page 2");
      expect(text).not.toContain("page 1");
    } finally {
      await doc.cleanup();
      await doc.loadingTask.destroy();
    }
  });

  it("skips outline entries whose dest is broken", async () => {
    const bytes = await makeTextPdf({ outline: true, brokenDest: true });
    const parsed = await parsePdf(bytes);
    // 坏 dest 条目被跳过，只剩好的那条
    expect(parsed.toc).toEqual([{ label: "Chapter One", href: "pdf-ch:0" }]);
    expect(parsed.chapterRanges).toEqual([{ startPage: 1, endPage: 3 }]);
  });

  it("keeps at least the start page for same-page adjacent chapters (deliberate one-page overlap)", async () => {
    const bytes = await makeTextPdf({ outline: true, samePageChapters: true });
    const parsed = await parsePdf(bytes);
    expect(parsed.chapterRanges).toEqual([
      { startPage: 1, endPage: 1 },
      { startPage: 1, endPage: 3 },
    ]);
  });
});
