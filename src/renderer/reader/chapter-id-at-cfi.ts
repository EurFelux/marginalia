import { EpubCFI } from "epubjs";
import type { ChapterRefDto } from "@shared/library";
import { chaptersMatchingHref } from "./chapter-id-by-href";

/** 共享 href 锚点章的边界：该章起点元素的 CFI。anchorBoundaries 按 cfi 升序排列。 */
export interface AnchorBoundary {
  chapterId: string;
  cfi: string;
}

/**
 * ePub 标注/位置 CFI → 章节 id（与 PDF chapterIdAtPage 对称）。
 * 两级：spinePos→href 唯一章直接返回；共享 href（锚点切章）用 anchorBoundaries 经 EpubCFI.compare 细分。
 * anchorBoundaries 未就绪/无该 href 边界 → null（退化，宁可不显示不错章）。
 */
export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
  anchorBoundaries: AnchorBoundary[] = [],
): string | null {
  let pos: number;
  try {
    pos = new EpubCFI(cfi).spinePos ?? -1;
  } catch {
    return null;
  }
  const href = pos >= 0 ? spineHrefs[pos] : undefined;
  if (!href) return null;

  const matches = chaptersMatchingHref(chapters, href);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.id;

  // 共享 href（锚点切章）→ anchor 级细分
  const ids = new Set(matches.map((c) => c.id));
  const relevant = anchorBoundaries.filter((b) => ids.has(b.chapterId));
  if (relevant.length === 0) return null;

  const epub = new EpubCFI();
  let picked: string | null = null;
  for (const b of relevant) {
    if (epub.compare(b.cfi, cfi) <= 0) picked = b.chapterId;
    else break;
  }
  return picked;
}
