// src/shared/book-notes.ts
import { z } from "zod";

export interface BookNoteDto {
  id: string;
  bookId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// content：.trim() 是转换——校验且落库的都是 trim 后的 Markdown 源码
export const createBookNoteInput = z.object({
  bookId: z.string().min(1),
  content: z.string().trim().min(1),
});
export type CreateBookNoteInput = z.infer<typeof createBookNoteInput>;

export const updateBookNoteInput = z.object({
  id: z.string().min(1),
  patch: z.object({ content: z.string().trim().min(1) }),
});
export type UpdateBookNoteInput = z.infer<typeof updateBookNoteInput>;

export const bookNoteIdInput = z.object({ id: z.string().min(1) });
export type BookNoteIdInput = z.infer<typeof bookNoteIdInput>;
