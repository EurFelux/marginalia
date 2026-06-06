import { desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { annotations, books } from "@main/db/schema";
import type {
  AnnotationDto,
  AnnotationStyle,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@shared/annotations";

type AnnotationRow = typeof annotations.$inferSelect;

function toDto(row: AnnotationRow): AnnotationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    style: row.style as AnnotationStyle,
    note: row.note,
    selectedText: row.selectedText,
    cfiRange: row.locatorRange, // TODO(T6): rename IPC field cfiRange→locatorRange
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 列出某书的全部标注（最近创建在前；阅读序排序在渲染层做）。 */
export function listAnnotationsByBook(db: DB, bookId: string): AnnotationDto[] {
  return db
    .select()
    .from(annotations)
    .where(eq(annotations.bookId, bookId))
    .orderBy(desc(annotations.createdAt))
    .all()
    .map(toDto);
}

/** 建标注；缺书抛可读错误。 */
export function createAnnotation(db: DB, input: CreateAnnotationInput): AnnotationDto {
  const book = db.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).get();
  if (!book) throw new Error(`createAnnotation: book ${input.bookId} not found`);
  const row = db
    .insert(annotations)
    .values({
      bookId: input.bookId,
      style: input.style,
      note: input.note,
      selectedText: input.selectedText,
      locatorRange: input.cfiRange, // TODO(T6): rename IPC field cfiRange→locatorRange
    })
    .returning()
    .get();
  return toDto(row);
}

/** 改样式/笔记；缺标注抛错。 */
export function updateAnnotation(db: DB, input: UpdateAnnotationInput): AnnotationDto {
  const row = db
    .update(annotations)
    .set({ ...input.patch, updatedAt: Date.now() })
    .where(eq(annotations.id, input.id))
    .returning()
    .get();
  if (!row) throw new Error(`updateAnnotation: annotation ${input.id} not found`);
  return toDto(row);
}

/** 删标注（幂等）。 */
export function deleteAnnotation(db: DB, id: string): void {
  db.delete(annotations).where(eq(annotations.id, id)).run();
}
