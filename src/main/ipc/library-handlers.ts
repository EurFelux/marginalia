import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BrowserWindow, dialog } from "electron";
import { IPC } from "@shared/ipc";
import {
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  type BookSummaryContentDto,
  type BookSummaryDto,
  type ChapterRefDto,
  type ChapterTextSlice,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import { getDb } from "@main/db/instance";
import { getBook, importBook, listBooks } from "@main/library/repository";
import { readBookBytes } from "@main/library/book-bytes";
import { getProgress, saveProgress } from "@main/library/progress";
import {
  getChapterSummary,
  getToc,
  listChapters,
  readChapterText,
  type ChapterSummary,
} from "@main/library/content";
import { ensureBookSummary, ensureChapterSummary, getBookSummaryView } from "@main/ai/summary";
import { makeSummaryDeps } from "@main/ai/send-deps";
import { handle } from "@main/ipc/registry";

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

  handle<void, string | null>(IPC.libraryPickEpub, z.void(), async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  handle<void, BookSummaryDto[]>(IPC.libraryList, z.void(), () => listBooks(getDb()).map(toDto));

  handle<{ bookId: string }, BookSummaryDto | null>(IPC.libraryGet, bookIdInput, (input) => {
    const b = getBook(getDb(), input.bookId);
    return b ? toDto(b) : null;
  });

  handle<{ bookId: string }, Uint8Array>(IPC.libraryReadEpubBytes, bookIdInput, (input) =>
    readBookBytes(getDb(), input.bookId),
  );

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

  handle<{ bookId: string }, ChapterRefDto[]>(IPC.contentChapters, bookIdInput, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return listChapters(db, input.bookId);
  });

  handle<{ bookId: string; chapterId: string }, ChapterSummary>(
    IPC.contentChapterSummary,
    chapterRefInput,
    (input) => getChapterSummary(getDb(), input.bookId, input.chapterId),
  );

  // 触发本章摘要懒生成（开章自动 / pill 手动按钮）。fire-and-forget：ensureChapterSummary
  // 仅从 pending 起、内部自含 reject 兜底；同步前缀会把 pending 置 generating，故返回当前状态即时反馈。
  handle<{ bookId: string; chapterId: string }, ChapterSummary>(
    IPC.contentGenerateChapterSummary,
    chapterRefInput,
    (input) => {
      const db = getDb();
      void ensureChapterSummary(makeSummaryDeps(), input.bookId, input.chapterId).catch((err) =>
        console.warn("[content] generate chapter summary failed:", err),
      );
      return getChapterSummary(db, input.bookId, input.chapterId);
    },
  );

  handle<{ bookId: string }, BookSummaryContentDto>(IPC.contentBookSummary, bookIdInput, (input) =>
    getBookSummaryView(getDb(), input.bookId),
  );

  // 触发全书摘要懒生成（书卡手动按钮）。fire-and-forget；同步前缀置 inFlight，故返回即为 generating。
  handle<{ bookId: string }, BookSummaryContentDto>(
    IPC.contentGenerateBookSummary,
    bookIdInput,
    (input) => {
      const db = getDb();
      // force=true：书卡「生成/重新生成」总是（重）生成，覆盖旧摘要。
      void ensureBookSummary(makeSummaryDeps(), input.bookId, true).catch((err) =>
        console.warn("[content] generate book summary failed:", err),
      );
      return getBookSummaryView(db, input.bookId);
    },
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
