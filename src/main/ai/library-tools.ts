// src/main/ai/library-tools.ts —— library 上下文的只读书库工具（spec 2026-06-16 §4.4）。
// 纯函数注入 DB；失败转 { error } 不抛（沿用 tools.ts 的 runTool 纪律，模型自纠）。
import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { runTool } from "@main/ai/tools";
import { listBooks, listRecentlyRead, getBook } from "@main/library/repository";
import { getBookSummaryView } from "@main/ai/summary";
import { listBookNotesByBook } from "@main/library/book-notes";
import { listAnnotationsByBook } from "@main/library/annotations";
import { aggregateReadingStats } from "@main/stats/aggregate";

export interface LibraryToolsDeps {
  db: DB;
}

export function createLibraryTools(deps: LibraryToolsDeps) {
  const { db } = deps;
  return {
    listBooks: tool({
      description:
        "List every book in the reader's library with reading state. Returns id, title, author, format, isFinished, progressPercent (0–1 or null), lastReadAt (ms or null). Start here to ground any recommendation or discussion.",
      inputSchema: z.object({}),
      execute: async () => {
        const recent = new Map(listRecentlyRead(db, Number.MAX_SAFE_INTEGER).map((r) => [r.id, r]));
        return listBooks(db).map((b) => {
          const r = recent.get(b.id);
          return {
            id: b.id,
            title: b.title,
            author: b.author,
            format: b.format,
            isFinished: b.isFinished,
            progressPercent: r?.percent ?? null,
            lastReadAt: r?.lastReadAt ?? null,
          };
        });
      },
    }),
    getBook: tool({
      description:
        "Get one book's details by its id (from listBooks): title, author, format, pageCount, isFinished, addedAt, and its AI book summary (status + text if ready).",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) =>
        runTool("getBook", () => {
          const book = getBook(db, bookId);
          if (!book) {
            throw new Error(`book not found: "${bookId}". Call listBooks and pass an exact id.`);
          }
          const summaryView = getBookSummaryView(db, bookId);
          return {
            title: book.title,
            author: book.author,
            format: book.format,
            pageCount: book.pageCount,
            isFinished: book.isFinished,
            addedAt: book.addedAt,
            summaryStatus: summaryView.status,
            // summary 直接读 book 列：getBookSummaryView.summary 与 book.summary 等价（无 inFlight 时），
            // 但避免 status gating 的边界差异；两者均来自 books.summary 列，测试断言对齐。
            summary: book.summary ?? null,
          };
        }),
    }),
    getBookNotes: tool({
      description: "Get the reader's free-form Markdown notes for one book (id from listBooks).",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) => runTool("getBookNotes", () => listBookNotesByBook(db, bookId)),
    }),
    listAnnotations: tool({
      description:
        "List the reader's highlights/annotations for one book (id from listBooks): selectedText, note, style.",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) =>
        runTool("listAnnotations", () =>
          listAnnotationsByBook(db, bookId).map((a) => ({
            selectedText: a.selectedText,
            note: a.note,
            style: a.style,
          })),
        ),
    }),
    getReadingStats: tool({
      description:
        "Get the reader's reading-time stats: total seconds, current streak, and per-book seconds. Use to gauge engagement and what they've been into lately.",
      inputSchema: z.object({}),
      execute: async () => runTool("getReadingStats", () => aggregateReadingStats(db)),
    }),
  };
}
