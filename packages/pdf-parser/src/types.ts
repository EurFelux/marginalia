/** 与 @marginalia/epub-parser 的 TocNode 同形（结构类型兼容，不引依赖）。 */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

/** 章节页范围（1-based 闭区间），与 toc 同序号对应（toc[i].href === "pdf-ch:i"）。 */
export interface ChapterRange {
  startPage: number;
  endPage: number;
}

/** parsePdf 的产物。 */
export interface ParsedPdf {
  title?: string;
  author?: string;
  pageCount: number;
  /** outline 压扁后的目录；无 outline 时为 []（消费方退化为单章）。 */
  toc: TocNode[];
  /** 章节页范围；无 outline 时为 [{ startPage: 1, endPage: pageCount }]。 */
  chapterRanges: ChapterRange[];
  /** 文本层检测：采样前 8 页平均字符数 < 阈值 → false（扫描版）。 */
  hasTextLayer: boolean;
}

/** 与 epub-parser 的 ChapterTextSlice 同形（结构类型兼容）。 */
export interface ChapterTextSlice {
  text: string;
  hasMore: boolean;
  nextOffset: number;
}
