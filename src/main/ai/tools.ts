// src/main/ai/tools.ts
import { tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { listChapters, readChapterText } from "@main/library/content";
import { getChapterSummaryView } from "@main/ai/summary";
import { resolveChapterByHref } from "@main/library/repository";

/** 取某书原始字节（生产实现读 app 自有派生路径；测试注入 fixture 字节）。 */
export type LoadBytes = (bookId: string) => Promise<Uint8Array>;

export interface ReadingToolsDeps {
  db: DB;
  bookId: string;
  loadBytes: LoadBytes;
}

/**
 * 把模型给的章节引用解析成规范 chapterId。既接受代理 uuid（chapters.id），
 * 也接受 getToc 返回的 href——模型常把目录里的 href 当 id 传，故两者都容忍。
 */
export function resolveChapterRef(db: DB, bookId: string, ref: string): string {
  const byId = db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, ref)))
    .get();
  if (byId) return byId.id;
  const byHref = resolveChapterByHref(db, bookId, ref);
  if (byHref) return byHref.id;
  throw new Error(`chapter not found by id or href: ${ref}`);
}

/** 当前书的只读阅读工具集（设计文档 §8）；全部在 main 执行，喂 streamText({ tools })。 */
export function createReadingTools(deps: ReadingToolsDeps) {
  const { db, bookId, loadBytes } = deps;
  return {
    getToc: tool({
      description:
        "List the book's chapters with their ids and titles. Use the returned `id` field as the chapterId for readChapterText and getChapterSummary.",
      inputSchema: z.object({}),
      execute: async () => listChapters(db, bookId),
    }),
    getChapterSummary: tool({
      description:
        "Get the cached AI summary (and its status) of a chapter by its id (from getToc).",
      inputSchema: z.object({ chapterId: z.string().min(1) }),
      execute: async ({ chapterId }) =>
        getChapterSummaryView(db, bookId, resolveChapterRef(db, bookId, chapterId)),
    }),
    readChapterText: tool({
      description:
        "Read the verbatim text of a chapter (id from getToc), paginated by character offset; returns { text, hasMore, nextOffset }.",
      inputSchema: z.object({
        chapterId: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      execute: async ({ chapterId, offset, maxChars }) => {
        const id = resolveChapterRef(db, bookId, chapterId);
        const bytes = await loadBytes(bookId);
        return await readChapterText(db, bytes, bookId, id, { offset, maxChars });
      },
    }),
  };
}
