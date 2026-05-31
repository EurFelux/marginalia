import { readFile } from "node:fs/promises";
import { z } from "zod";
import { IPC } from "@shared/ipc";
import {
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  type BookSummaryDto,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import { getDb } from "@main/db/instance";
import { getBook, importBook, listBooks } from "@main/library/repository";
import { getProgress, saveProgress } from "@main/library/progress";
import {
  getChapterSummary,
  getToc,
  readChapterText,
  type ChapterSummary,
} from "@main/library/content";
import { handle } from "@main/ipc/registry";
import type { ChapterTextSlice } from "@marginalia/epub-parser";

const toDto = (b: {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
}): BookSummaryDto => ({
  id: b.id,
  title: b.title,
  author: b.author,
  path: b.path,
});

export function registerLibraryHandlers(): void {
  handle<{ filePath: string }, BookSummaryDto>(
    IPC.libraryImport,
    importBookInput,
    async (input) => {
      const buf = await readFile(input.filePath).catch((err: NodeJS.ErrnoException) => {
        throw new Error(`Cannot read epub file at "${input.filePath}": ${err.code ?? err.message}`);
      });
      const bytes = new Uint8Array(buf);
      return toDto(importBook(getDb(), { bytes, filePath: input.filePath }));
    },
  );

  handle<void, BookSummaryDto[]>(IPC.libraryList, z.void(), () => listBooks(getDb()).map(toDto));

  handle<{ bookId: string }, BookSummaryDto | null>(IPC.libraryGet, bookIdInput, (input) => {
    const b = getBook(getDb(), input.bookId);
    return b ? toDto(b) : null;
  });

  handle<{ bookId: string }, { cfi: string } | null>(IPC.progressGet, bookIdInput, (input) => {
    const p = getProgress(getDb(), input.bookId);
    return p ? { cfi: p.cfi } : null;
  });

  handle<{ bookId: string; cfi: string }, void>(IPC.progressSave, saveProgressInput, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId))
      throw new Error(`progress:save — book ${input.bookId} not found`);
    saveProgress(db, input.bookId, input.cfi);
  });

  handle<{ bookId: string }, TocNode[]>(IPC.contentToc, bookIdInput, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return getToc(db, input.bookId);
  });

  handle<{ bookId: string; chapterId: string }, ChapterSummary>(
    IPC.contentChapterSummary,
    chapterRefInput,
    (input) => getChapterSummary(getDb(), input.bookId, input.chapterId),
  );

  handle<
    { bookId: string; chapterId: string; offset?: number; maxChars?: number },
    ChapterTextSlice
  >(IPC.contentChapterText, readChapterTextInput, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`content: book ${input.bookId} not found`);
    const buf = await readFile(book.path).catch((err: NodeJS.ErrnoException) => {
      throw new Error(
        `Cannot read epub for book "${input.bookId}" at "${book.path}": ${err.code ?? err.message}. The file may have been moved or deleted.`,
      );
    });
    const bytes = new Uint8Array(buf);
    return readChapterText(db, bytes, input.bookId, input.chapterId, {
      offset: input.offset,
      maxChars: input.maxChars,
    });
  });
}
