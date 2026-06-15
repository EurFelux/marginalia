import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtCfi, type AnchorBoundary } from "./chapter-id-at-cfi";

const ch = (id: string, href: string, orderIndex: number): ChapterRefDto => ({
  id,
  title: id,
  href,
  anchor: null,
  orderIndex,
  level: 0,
  startPage: null,
  endPage: null,
});

// spine 物理顺序：cover(0), copyright(1), chap1(2), chap2(3)
const spineHrefs = ["cover.xhtml", "copyright.xhtml", "text/chap1.xhtml", "text/chap2.xhtml"];
// 章节是 TOC 子集（封面/版权不在），orderIndex 跟 TOC 走、与 spinePos 基准不同
const chapters = [ch("id-c1", "text/chap1.xhtml", 0), ch("id-c2", "text/chap2.xhtml", 1)];

describe("chapterIdAtCfi", () => {
  it("maps spinePos to the right chapter despite cover/copyright offset (the bug)", () => {
    // /6/6 → spinePos 2 → spineHrefs[2] = text/chap1.xhtml → id-c1
    // 旧逻辑会拿 spinePos 2 撞 orderIndex 2（不存在）→ 错章/空
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/6!/4/2/1:0)")).toBe("id-c1");
    // /6/8 → spinePos 3 → text/chap2.xhtml → id-c2
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/8!/4/2/1:0)")).toBe("id-c2");
  });

  it("returns null for a non-chapter spine item (cover)", () => {
    // /6/2 → spinePos 0 → cover.xhtml（不在 chapters）→ null
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/2!/4/2/1:0)")).toBeNull();
  });

  it("returns null when spinePos is out of range", () => {
    // /6/20 → spinePos 9 → spineHrefs[9] = undefined → null
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/20!/4/2/1:0)")).toBeNull();
  });

  it("returns null for an invalid CFI (EpubCFI throws)", () => {
    expect(chapterIdAtCfi(chapters, spineHrefs, "not-a-cfi")).toBeNull();
  });

  it("returns null when spineHrefs is empty (book not ready)", () => {
    expect(chapterIdAtCfi(chapters, [], "epubcfi(/6/6!/4/2/1:0)")).toBeNull();
  });

  it("falls back to basename when spine href prefix differs from chapter href", () => {
    // spineHrefs 是 epubjs 裸 href；chapters 带 OEBPS 前缀 → exact 不中、basename 命中
    const prefixed = [ch("id-c1", "OEBPS/text/chap1.xhtml", 0)];
    expect(chapterIdAtCfi(prefixed, spineHrefs, "epubcfi(/6/6!/4/2/1:0)")).toBe("id-c1");
  });
});

describe("chapterIdAtCfi anchor-level", () => {
  const sharedHrefs = ["text/all.html"];
  const sharedChapters: ChapterRefDto[] = [
    {
      id: "c1",
      title: "C1",
      href: "text/all.html",
      anchor: "p1",
      orderIndex: 0,
      level: 0,
      startPage: null,
      endPage: null,
    },
    {
      id: "c2",
      title: "C2",
      href: "text/all.html",
      anchor: "p2",
      orderIndex: 1,
      level: 0,
      startPage: null,
      endPage: null,
    },
    {
      id: "c3",
      title: "C3",
      href: "text/all.html",
      anchor: "p3",
      orderIndex: 2,
      level: 0,
      startPage: null,
      endPage: null,
    },
  ];
  const boundaries: AnchorBoundary[] = [
    { chapterId: "c1", cfi: "epubcfi(/6/2!/4/10/1:0)" },
    { chapterId: "c2", cfi: "epubcfi(/6/2!/4/100/1:0)" },
    { chapterId: "c3", cfi: "epubcfi(/6/2!/4/200/1:0)" },
  ];

  it("subdivides a shared href to the right anchor chapter", () => {
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/150,/1:0,/1:5)", boundaries),
    ).toBe("c2");
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/5,/1:0,/1:5)", boundaries),
    ).toBeNull();
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/250,/1:0,/1:5)", boundaries),
    ).toBe("c3");
  });

  it("falls back to null when boundaries are not ready (shared href, empty boundaries)", () => {
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/150,/1:0,/1:5)", []),
    ).toBeNull();
  });
});
