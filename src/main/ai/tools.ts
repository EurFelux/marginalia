// src/main/ai/tools.ts
import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { getChapterSummary, getToc, readChapterText } from "@main/library/content";

/** 取某书原始字节（生产实现读 books.path；测试注入 fixture 字节）。 */
export type LoadBytes = (bookId: string) => Promise<Uint8Array>;

export interface ReadingToolsDeps {
  db: DB;
  bookId: string;
  loadBytes: LoadBytes;
}

/** 当前书的只读阅读工具集（设计文档 §8）；全部在 main 执行，喂 streamText({ tools })。 */
export function createReadingTools(deps: ReadingToolsDeps) {
  const { db, bookId, loadBytes } = deps;
  return {
    getToc: tool({
      description: "List the table of contents (chapters) of the current book.",
      inputSchema: z.object({}),
      execute: async () => getToc(db, bookId),
    }),
    getChapterSummary: tool({
      description: "Get the cached AI summary (and its status) of a chapter by its id.",
      inputSchema: z.object({ chapterId: z.string().min(1) }),
      execute: async ({ chapterId }) => getChapterSummary(db, bookId, chapterId),
    }),
    readChapterText: tool({
      description:
        "Read the verbatim text of a chapter, paginated by character offset; returns { text, hasMore, nextOffset }.",
      inputSchema: z.object({
        chapterId: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      execute: async ({ chapterId, offset, maxChars }) => {
        const bytes = await loadBytes(bookId);
        return readChapterText(db, bytes, bookId, chapterId, { offset, maxChars });
      },
    }),
  };
}
