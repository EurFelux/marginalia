import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtPage } from "./pdf-chapter-at-page";

const ch = (id: string, startPage: number | null, orderIndex: number): ChapterRefDto => ({
  id,
  title: id,
  href: `pdf-ch:${orderIndex}`,
  anchor: null,
  orderIndex,
  level: 0,
  startPage,
  endPage: null,
});

describe("chapterIdAtPage", () => {
  const chapters = [ch("a", 1, 0), ch("b", 5, 1), ch("c", 5, 2), ch("d", 20, 3)];

  it("picks the last chapter whose startPage <= page", () => {
    expect(chapterIdAtPage(chapters, 1)).toBe("a");
    expect(chapterIdAtPage(chapters, 4)).toBe("a");
    expect(chapterIdAtPage(chapters, 19)).toBe("c"); // 同页起章归后者
    expect(chapterIdAtPage(chapters, 20)).toBe("d");
    expect(chapterIdAtPage(chapters, 999)).toBe("d");
  });

  it("returns null before the first chapter or without page data", () => {
    expect(chapterIdAtPage([ch("x", 3, 0)], 2)).toBeNull();
    expect(chapterIdAtPage([ch("e", null, 0)], 1)).toBeNull(); // epub 形状的章（无页范围）
    expect(chapterIdAtPage([], 1)).toBeNull();
  });
});
