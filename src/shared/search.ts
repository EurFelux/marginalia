import { z } from "zod";
import type { Snippet } from "@shared/text-search";

/** 书内搜索（spec 2026-09-24 in-book-search）。 */
export const searchBookInput = z.object({
  bookId: z.string().min(1),
  query: z.string().min(1).max(200),
});
export type SearchBookInput = z.infer<typeof searchBookInput>;

/** 单次搜索返回的命中上限；超出则 truncated。 */
export const MAX_SEARCH_HITS = 500;

/**
 * 命中定位：ePub 给「spine 文件内第几个命中」（渲染层在 iframe 文档上重算锚定，对解析细节差异稳健）；
 * PDF 给文本层文本流偏移（与 PDF 标注同一坐标空间）。
 */
export type SearchHitTarget =
  | { format: "epub"; href: string; occurrence: number }
  | { format: "pdf"; page: number; start: number; end: number };

export interface BookSearchHit {
  chapterId: string | null;
  chapterTitle: string | null;
  snippet: Snippet;
  target: SearchHitTarget;
}

export type BookSearchResult =
  | { kind: "ok"; hits: BookSearchHit[]; truncated: boolean }
  | { kind: "no-text-layer" };
