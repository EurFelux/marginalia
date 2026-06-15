import { EpubCFI } from "epubjs";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref } from "./chapter-id-by-href";

/**
 * ePub 标注/位置 CFI → 章节 id（与 PDF 的 chapterIdAtPage 对称）。
 * CFI 的 spinePos（epubjs spine 物理位置）→ spineHrefs[pos]（spine 顺序的 href）→ chapterIdByHref。
 * 切勿用 CFI.spinePos 去撞 chapter.orderIndex：orderIndex 是 TOC 扁平下标，与 spinePos 基准不同。
 */
export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
): string | null {
  let pos: number;
  try {
    pos = new EpubCFI(cfi).spinePos ?? -1; // 无效 CFI：构造即抛 → catch
  } catch {
    return null;
  }
  const href = pos >= 0 ? spineHrefs[pos] : undefined; // 越界/负 → undefined
  return href ? chapterIdByHref(chapters, href) : null;
}
