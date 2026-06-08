import { z } from "zod";

export const importBookInput = z.object({ filePath: z.string().min(1) });
export type ImportBookInput = z.infer<typeof importBookInput>;

export const bookIdInput = z.object({ bookId: z.string().min(1) });
export type BookIdInput = z.infer<typeof bookIdInput>;

/** #29 书籍信息编辑。put 语义：两字段必传；author=null 显式清空（回「未知作者」显示）。空串收敛（""→null）由 renderer 表单完成，此处 min(1) 拒空串防绕过 UI 的脏输入。 */
export const updateBookInput = z.object({
  bookId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().min(1).max(500).nullable(),
});
export type UpdateBookInput = z.infer<typeof updateBookInput>;

export const saveProgressInput = z.object({
  bookId: z.string().min(1),
  locator: z.string().min(1),
  /** 0–1 阅读进度快照；reader 计算上送（spec 2026-06-07-library-shelf-reorder §4）。 */
  percent: z.number().min(0).max(1).nullish(),
});
export type SaveProgressInput = z.infer<typeof saveProgressInput>;

export const chapterRefInput = z.object({
  bookId: z.string().min(1),
  chapterId: z.string().min(1),
});
export type ChapterRefInput = z.infer<typeof chapterRefInput>;

export const readChapterTextInput = chapterRefInput.extend({
  offset: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
});
export type ReadChapterTextInput = z.infer<typeof readChapterTextInput>;

/** 手动（重）生成传 `force: true` 跳过 ready-skip；自动触发（开章）不传，已 ready 即廉价 no-op。 */
export const generateChapterSummaryInput = chapterRefInput.extend({
  force: z.boolean().optional(),
});
export type GenerateChapterSummaryInput = z.infer<typeof generateChapterSummaryInput>;

export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  hasCover: boolean;
  format: "epub" | "pdf";
  pageCount: number | null;
  hasTextLayer: boolean;
}

export const reorderBooksInput = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderBooksInput = z.infer<typeof reorderBooksInput>;

/** 「继续阅读」shelf 条目（#48）：书摘要 + 进度快照。 */
export interface RecentlyReadDto extends BookSummaryDto {
  percent: number | null; // 0–1；老数据 null → 卡片不渲染进度行
  lastReadAt: number; // = progress.updatedAt
}

/**
 * 章节文本分页切片。单一来源在 `@marginalia/epub-parser`（`extractChapterText` 的产出形状），
 * 这里 re-export 供 renderer/preload 消费——与 `@shared/types` re-export `TocNode` 同一模式，避免重复定义漂移。
 */
export type { ChapterTextSlice } from "@marginalia/epub-parser";

/**
 * 章节导航引用：渲染层据此列章 / 取 surrogate id 喂 content.chapterText。
 * 章节以 TOC 为准（有标题的目录条目）；`level` 表达层级（0=章，1+=节，源自 TOC 嵌套）。
 * 仅在 epub 无 TOC 的兜底路径里 title 可能为 null。
 */
export interface ChapterRefDto {
  id: string;
  title: string | null;
  href: string;
  anchor: string | null; // 章内 #fragment（锚点级章节）；无锚点章为 null
  orderIndex: number;
  level: number;
  startPage: number | null; // PDF 章节页范围（1-based 闭区间）；epub 为 null
  endPage: number | null;
}

/** 章节/全书摘要的派生状态机（主进程读取时派生，不入 DB；见 DB lifecycle spec §2 / DD-§2）。 */
export type SummaryStatus = "pending" | "generating" | "ready" | "unavailable";

/** content:chapter-summary 返回：摘要状态 + 正文（ready 时非空）。 */
export interface ChapterSummaryDto {
  status: SummaryStatus;
  summary: string | null;
}

/**
 * content:book-summary 返回：全书摘要状态 + 正文（ready 时非空）。
 * status 在主进程**读取时派生**（books 只持久化 summary；见 book-summary spec），形状同 chapter 版。
 */
export interface BookSummaryContentDto {
  status: SummaryStatus;
  summary: string | null;
}
