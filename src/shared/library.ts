import { z } from "zod";

export const importBookInput = z.object({ filePath: z.string().min(1) });
export type ImportBookInput = z.infer<typeof importBookInput>;

export const bookIdInput = z.object({ bookId: z.string().min(1) });
export type BookIdInput = z.infer<typeof bookIdInput>;

export const saveProgressInput = z.object({ bookId: z.string().min(1), cfi: z.string().min(1) });
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

export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
}

/**
 * 章节文本分页切片。单一来源在 `@marginalia/epub-parser`（`extractChapterText` 的产出形状），
 * 这里 re-export 供 renderer/preload 消费——与 `@shared/types` re-export `TocNode` 同一模式，避免重复定义漂移。
 */
export type { ChapterTextSlice } from "@marginalia/epub-parser";
