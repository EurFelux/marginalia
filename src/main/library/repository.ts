import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseEpub, type TocNode } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";

export interface ImportInput {
  bytes: Uint8Array;
  filePath: string;
}
export type BookRow = typeof books.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;

function tocLabelByHref(toc: TocNode[], acc = new Map<string, string>()): Map<string, string> {
  for (const n of toc) {
    if (n.href && !acc.has(n.href)) acc.set(n.href, n.label);
    if (n.children) tocLabelByHref(n.children, acc);
  }
  return acc;
}

export function importBook(db: DB, input: ImportInput): BookRow {
  const parsed = parseEpub(input.bytes);
  const id = parsed.uid || createHash("sha256").update(input.bytes).digest("hex");

  // 幂等：已在库则直接返回，不重新解析、不动 chapters（零 churn）。
  // "显式刷新/重新导入"留后续里程碑：届时按 (book_id, href) 稳定 upsert，
  // 保 chapter id 不变，供 MA4 章节绑定会话存活。
  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  return db.transaction((tx) => {
    tx.insert(books)
      .values({
        id,
        path: input.filePath,
        title: parsed.title ?? null,
        author: parsed.author ?? null,
        cover: parsed.cover ? Buffer.from(parsed.cover) : null,
        toc: parsed.toc,
      })
      .run();

    const labels = tocLabelByHref(parsed.toc);
    parsed.spine.forEach((item, index) => {
      tx.insert(chapters)
        .values({
          bookId: id,
          href: item.href,
          orderIndex: index,
          title: labels.get(item.href) ?? null,
          summaryStatus: "pending",
        })
        .run();
    });

    const row = tx.select().from(books).where(eq(books.id, id)).get();
    if (!row) throw new Error("importBook: book row missing after insert");
    return row;
  });
}

export function listBooks(db: DB): BookRow[] {
  return db.select().from(books).all();
}
export function getBook(db: DB, id: string): BookRow | undefined {
  return db.select().from(books).where(eq(books.id, id)).get();
}
export function resolveChapterByHref(db: DB, bookId: string, href: string): ChapterRow | undefined {
  return db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.href, href)))
    .get();
}
