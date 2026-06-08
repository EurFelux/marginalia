import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref } from "./chapter-id-by-href";

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
