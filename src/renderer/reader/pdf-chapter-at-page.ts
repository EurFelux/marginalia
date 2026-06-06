import type { ChapterRefDto } from "@shared/library";

/**
 * 当前页所属章 = startPage ≤ page 的最后一章（chapters 按 orderIndex 升序）。
 * 同页起章（outline 重叠，parse 端刻意允许）归后者——与「最近的标题」直觉一致。
 * 无匹配（page 在首章前 / 无页数据）→ null。
 */
export function chapterIdAtPage(chapters: ChapterRefDto[], page: number): string | null {
  let hit: string | null = null;
  for (const c of chapters) {
    if (c.startPage != null && c.startPage <= page) hit = c.id;
  }
  return hit;
}
