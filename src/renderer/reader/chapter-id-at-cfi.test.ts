import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtCfi } from "./chapter-id-at-cfi";

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
