import { desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { bookNotes, books } from "@main/db/schema";
import type { BookNoteDto, CreateBookNoteInput, UpdateBookNoteInput } from "@shared/book-notes";

type BookNoteRow = typeof bookNotes.$inferSelect;

function toDto(row: BookNoteRow): BookNoteDto {
  return {
    id: row.id,
    bookId: row.bookId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 列出某书的全部笔记（按 createdAt 降序，最近创建在前；此即渲染层的展示顺序）。 */
export function listBookNotesByBook(db: DB, bookId: string): BookNoteDto[] {
  return db
    .select()
    .from(bookNotes)
    .where(eq(bookNotes.bookId, bookId))
    .orderBy(desc(bookNotes.createdAt))
    .all()
    .map(toDto);
}

/** 建笔记；缺书抛可读错误（镜像 createAnnotation 的 FK 预检）。 */
export function createBookNote(db: DB, input: CreateBookNoteInput): BookNoteDto {
  const book = db.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).get();
  if (!book) throw new Error(`createBookNote: book ${input.bookId} not found`);
  const row = db
    .insert(bookNotes)
    .values({ bookId: input.bookId, content: input.content })
    .returning()
    .get();
  return toDto(row);
}

/** 改内容并刷新 updatedAt；缺行抛可读错误。 */
export function updateBookNote(db: DB, input: UpdateBookNoteInput): BookNoteDto {
  const row = db
    .update(bookNotes)
    .set({ content: input.patch.content, updatedAt: Date.now() })
    .where(eq(bookNotes.id, input.id))
    .returning()
    .get();
  if (!row) throw new Error(`updateBookNote: book note ${input.id} not found`);
  return toDto(row);
}

/** 删笔记；缺行抛可读错误（有意区别于 deleteAnnotation 的幂等语义，勿向任一侧「修齐」）。 */
export function deleteBookNote(db: DB, id: string): void {
  const res = db.delete(bookNotes).where(eq(bookNotes.id, id)).run();
  if (res.changes === 0) throw new Error(`deleteBookNote: book note ${id} not found`);
}
