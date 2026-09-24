import { describe, expect, it } from "vitest";
import { findMatches, snippetAround, type SearchableText } from "@shared/text-search";

const src = (text: string, breaks: number[] = []): SearchableText => ({ text, breaks });
const found = (source: SearchableText, query: string) =>
  findMatches(source, query).map((m) => source.text.slice(m.start, m.end));

describe("findMatches", () => {
  it("matches case-insensitively and maps back to the original text", () => {
    const s = src("The Margin and the margins");
    expect(found(s, "MARGIN")).toEqual(["Margin", "margin"]);
    expect(findMatches(s, "margin")[0]).toEqual({ start: 4, end: 10 });
  });

  it("treats full-width and half-width forms as equal", () => {
    expect(found(src("版本 ＡＢＣ１２３ 发布"), "abc123")).toEqual(["ＡＢＣ１２３"]);
    expect(found(src("version abc123"), "ＡＢＣ")).toEqual(["abc"]);
  });

  it("collapses whitespace runs, including non-breaking and ideographic spaces", () => {
    expect(found(src("read  in the\n\tmargins"), "in the margins")).toEqual(["in the\n\tmargins"]);
  });

  it("treats an ideographic space like any other whitespace", () => {
    expect(found(src("Part\u3000One"), "part one")).toEqual(["Part\u3000One"]);
  });

  it("ignores line breaks between CJK characters", () => {
    expect(found(src("在书页的\n边缘阅读"), "的边缘")).toEqual(["的\n边缘"]);
    expect(found(src("在书页的 边缘"), "书页的边缘")).toEqual(["书页的 边缘"]);
  });

  it("treats a virtual break as whitespace so adjacent blocks do not fuse", () => {
    // "end." | "Start" 是两个块：文本流里相邻，断点记在 4
    const s = src("end.Start", [4]);
    expect(found(s, "end. start")).toEqual(["end.Start"]);
    expect(found(s, "end.start")).toEqual([]);
  });

  it("returns non-overlapping matches in order", () => {
    expect(findMatches(src("aaaa"), "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("stops at the given limit", () => {
    expect(findMatches(src("a a a a"), "a", 2)).toHaveLength(2);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findMatches(src("anything"), "")).toEqual([]);
    expect(findMatches(src("anything"), "   ")).toEqual([]);
  });

  it("maps compatibility expansions back to the whole source character", () => {
    // ﬁ（U+FB01）经 NFKC 展开为 fi：命中范围覆盖整个原字符
    expect(found(src("the ﬁrst page"), "first")).toEqual(["ﬁrst"]);
  });
});

describe("snippetAround", () => {
  it("returns collapsed context around the match with ellipses where cut", () => {
    const s = src("one two three four five six seven");
    const [m] = findMatches(s, "four");
    expect(snippetAround(s, m!, { before: 8, after: 5 })).toEqual({
      before: "…o three ",
      match: "four",
      after: " five…",
    });
  });

  it("renders virtual breaks as spaces and omits ellipses at the edges", () => {
    const s = src("Title\nBody text", [5]);
    const [m] = findMatches(s, "body");
    expect(snippetAround(s, m!, { before: 40, after: 40 })).toEqual({
      before: "Title ",
      match: "Body",
      after: " text",
    });
  });
});
