import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseEpub, type TocNode } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { deleteEpubFile } from "@main/library/book-files";

export interface ImportInput {
  bytes: Uint8Array;
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
  const id = parsed.uid ?? createHash("sha256").update(input.bytes).digest("hex");

  // 幂等：已在库则直接返回，不写入 books/chapters（零 DB churn）。注：parseEpub 在幂等检查前已执行（id 派生需要它）。
  // "显式刷新/重新导入"留后续里程碑（按 (book_id, href) 稳定 upsert 保 chapter id）。
  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  return db.transaction((tx) => {
    tx.insert(books)
      .values({
        id,
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

/**
 * 删书：先删 DB 行（真相源；依赖行靠 FK ON DELETE CASCADE 自动清，P3a），再 best-effort 删自有副本文件。
 * 顺序不可反——指向已删文件的 DB 行 = 打不开的鬼书，比无主文件（可 GC）更糟（DD-§1.3）。
 * 幂等：删不存在的书是 no-op（DELETE 命中 0 行 + unlink 吞 ENOENT），不抛——契合删书 UI 的重复点击 / 乐观删除竞态。
 */
export async function deleteBook(db: DB, booksDir: string, bookId: string): Promise<void> {
  db.delete(books).where(eq(books.id, bookId)).run();
  await deleteEpubFile(booksDir, bookId);
}
