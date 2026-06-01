import { and, asc, eq } from "drizzle-orm";
import { extractChapterText, type ReadOptions } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { tocNodeSchema, type TocNode } from "@shared/types";
import type { ChapterRefDto, ChapterTextSlice } from "@shared/library";

export interface ChapterSummary {
  status: "pending" | "generating" | "ready" | "unavailable";
  summary: string | null;
}

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  // Because tocNodeSchema is recursive, a node whose *any* descendant fails validation causes the
  // entire top-level entry to be dropped — intentional defensive degradation for now; surgical
  // subtree pruning is a future follow-up.
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
  opts: ReadOptions,
): ChapterTextSlice {
  const ch = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return extractChapterText(bytes, ch.href, opts);
}

/** 按 spine 顺序（orderIndex）列出某书全部章节引用。title 可能为 null（TOC 无对应 label 时）。 */
export function listChapters(db: DB, bookId: string): ChapterRefDto[] {
  return db
    .select({
      id: chapters.id,
      title: chapters.title,
      href: chapters.href,
      orderIndex: chapters.orderIndex,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all()
    .map((c) => ({ id: c.id, title: c.title, href: c.href, orderIndex: c.orderIndex ?? 0 }));
}
