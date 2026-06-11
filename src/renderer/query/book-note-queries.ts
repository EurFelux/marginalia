// src/renderer/query/book-note-queries.ts
import type { BookNoteDto } from "@shared/book-notes";
import { qk } from "@renderer/query/keys";

/** 书籍笔记列表 query（侧栏 tab 与书库 Dialog 共用）。无主进程后台推进，默认 staleTime 即可。 */
export function bookNotesQuery(bookId: string) {
  return {
    queryKey: qk.bookNotes(bookId),
    queryFn: (): Promise<BookNoteDto[]> => window.api.bookNotes.listByBook({ bookId }),
  } as const;
}
