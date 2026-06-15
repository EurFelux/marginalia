import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref, chaptersMatchingHref } from "./chapter-id-by-href";

const chapters: ChapterRefDto[] = [
  {
    id: "id-cover",
    title: "Cover",
    href: "cover.xhtml",
    anchor: null,
    orderIndex: 0,
    level: 0,
    startPage: null,
    endPage: null,
  },
  {
    id: "id-c1",
    title: "Chapter 1",
    href: "text/chap1.xhtml",
    anchor: null,
    orderIndex: 1,
    level: 0,
    startPage: null,
    endPage: null,
  },
  {
    id: "id-c2",
    title: "Chapter 2",
    href: "text/chap2.xhtml",
    anchor: null,
    orderIndex: 2,
    level: 0,
    startPage: null,
    endPage: null,
  },
];

describe("chapterIdByHref", () => {
  it("matches an exact href", () => {
    expect(chapterIdByHref(chapters, "text/chap1.xhtml")).toBe("id-c1");
  });
  it("ignores a #fragment on the lookup href", () => {
    expect(chapterIdByHref(chapters, "text/chap2.xhtml#sec3")).toBe("id-c2");
  });
  it("falls back to basename when path prefixes differ", () => {
    expect(chapterIdByHref(chapters, "OEBPS/text/chap1.xhtml")).toBe("id-c1");
  });
  it("returns null when nothing matches", () => {
    expect(chapterIdByHref(chapters, "missing.xhtml")).toBeNull();
  });

  it("returns null when a basename fallback is ambiguous (multi-part same filename)", () => {
    const multiPart: ChapterRefDto[] = [
      {
        id: "id-p1",
        title: "Part 1 Intro",
        href: "part1/intro.xhtml",
        anchor: null,
        orderIndex: 0,
        level: 0,
        startPage: null,
        endPage: null,
      },
      {
        id: "id-p2",
        title: "Part 2 Intro",
        href: "part2/intro.xhtml",
        anchor: null,
        orderIndex: 1,
        level: 0,
        startPage: null,
        endPage: null,
      },
    ];
    // 前缀不一致触发 basename 兜底；intro.xhtml 同时命中两卷 → 歧义 → null（宁可不高亮也不错章）。
    expect(chapterIdByHref(multiPart, "OEBPS/part1/intro.xhtml")).toBeNull();
  });
});

describe("chaptersMatchingHref", () => {
  it("returns the single exact match", () => {
    expect(chaptersMatchingHref(chapters, "text/chap1.xhtml").map((c) => c.id)).toEqual(["id-c1"]);
  });
  it("returns ALL chapters sharing one href (anchor chapters)", () => {
    const shared: ChapterRefDto[] = [
      {
        id: "a",
        title: "A",
        href: "text/all.html",
        anchor: "p1",
        orderIndex: 0,
        level: 0,
        startPage: null,
        endPage: null,
      },
      {
        id: "b",
        title: "B",
        href: "text/all.html",
        anchor: "p2",
        orderIndex: 1,
        level: 0,
        startPage: null,
        endPage: null,
      },
      {
        id: "c",
        title: "C",
        href: "text/all.html",
        anchor: "p3",
        orderIndex: 2,
        level: 0,
        startPage: null,
        endPage: null,
      },
    ];
    expect(chaptersMatchingHref(shared, "text/all.html").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("falls back to basename matches", () => {
    expect(chaptersMatchingHref(chapters, "OEBPS/text/chap1.xhtml").map((c) => c.id)).toEqual([
      "id-c1",
    ]);
  });
  it("returns empty when nothing matches", () => {
    expect(chaptersMatchingHref(chapters, "missing.xhtml")).toEqual([]);
  });
});
