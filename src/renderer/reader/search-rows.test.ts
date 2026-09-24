import { describe, expect, it } from "vitest";
import type { BookSearchHit } from "@shared/search";
import { searchRows } from "./search-rows";

const epubHit = (chapterId: string | null): BookSearchHit => ({
  chapterId,
  chapterTitle: chapterId,
  snippet: { before: "", match: "x", after: "" },
  target: { format: "epub", href: "a.xhtml", occurrence: 0 },
});
const pdfHit = (page: number): BookSearchHit => ({
  chapterId: null,
  chapterTitle: null,
  snippet: { before: "", match: "x", after: "" },
  target: { format: "pdf", page, start: 0, end: 1 },
});

describe("searchRows", () => {
  it("inserts a group row whenever the chapter changes and maps hits to their rows", () => {
    const { rows, rowOfHit } = searchRows([epubHit("a"), epubHit("a"), epubHit("b")]);
    expect(rows.map((r) => (r.kind === "group" ? `#${r.hit.chapterId}` : r.index))).toEqual([
      "#a",
      0,
      1,
      "#b",
      2,
    ]);
    expect(rowOfHit).toEqual([1, 2, 4]);
  });

  it("groups chapterless pdf hits by page", () => {
    const { rows } = searchRows([pdfHit(3), pdfHit(3), pdfHit(7)]);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(2);
  });

  it("is empty for no hits", () => {
    expect(searchRows([])).toEqual({ rows: [], rowOfHit: [] });
  });
});
