import { and, eq } from "drizzle-orm";
import { extractChapterText, type ChapterTextSlice } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { tocNodeSchema, type TocNode } from "@shared/types";

export interface ChapterSummary {
  status: "pending" | "generating" | "ready" | "unavailable";
  summary: string | null;
}

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  return (row?.toc ?? []).filter((n) => tocNodeSchema.safeParse(n).success);
}

export function getChapterSummary(db: DB, bookId: string, chapterId: string): ChapterSummary {
  const row = db
    .select({ summary: chapters.summary, status: chapters.summaryStatus })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return { status: row.status, summary: row.summary ?? null };
}

export function readChapterText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
  opts: { offset?: number; maxChars?: number },
): ChapterTextSlice {
  const ch = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return extractChapterText(bytes, ch.href, opts);
}
