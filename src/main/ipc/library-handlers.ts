import path from "node:path";
import { readFile } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import type { BookSummaryDto } from "@shared/library";
import { getDb } from "@main/db/instance";
import { appService } from "@main/app";
import {
  deleteBook,
  getBook,
  importBook,
  listBooks,
  listRecentlyRead,
  reorderBooks,
  updateBook,
} from "@main/library/repository";
import { readBookFile, writeBookFile } from "@main/library/book-files";
import { getProgress, saveProgress } from "@main/library/progress";
import { assertTextLayer, getToc, listChapters, readChapterText } from "@main/library/content";
import {
  assertSummaryModelReady,
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  getChapterSummaryView,
} from "@main/ai/summary";
import { makeSummaryDeps } from "@main/ai/send-deps";
import { bind, register, type Binding } from "@main/ipc/registry";
import { createLogger } from "@main/logger";

const log = createLogger("library");

const toDto = (b: {
  id: string;
  title: string | null;
  author: string | null;
  hasCover: boolean;
  format: "epub" | "pdf";
  pageCount: number | null;
  hasTextLayer: boolean;
}): BookSummaryDto => ({
  id: b.id,
  title: b.title,
  author: b.author,
  hasCover: Boolean(b.hasCover),
  format: b.format,
  pageCount: b.pageCount,
  hasTextLayer: Boolean(b.hasTextLayer),
});

export const libraryBindings: Binding[] = [
  bind(C.libraryImport, async (input) => {
    const buf = await readFile(input.filePath).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`Cannot read book file at "${input.filePath}": ${err.code ?? err.message}`);
    });
    const bytes = new Uint8Array(buf);
    const book = await importBook(getDb(), { bytes, fileName: path.basename(input.filePath) });
    await writeBookFile(appService.getPath("booksDir"), book.id, book.format, bytes); // 复制进 app 自有位置（relink/重导即覆盖）
    log.info(`book imported: ${book.id} (${book.format}, ${Math.round(bytes.length / 1024)}KB)`);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),

  bind(C.libraryPickBook, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "Books", extensions: ["epub", "pdf"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  }),

  bind(C.libraryList, () => listBooks(getDb()).map(toDto)),

  bind(C.libraryGet, (input) => {
    const b = getBook(getDb(), input.bookId);
    return b ? toDto({ ...b, hasCover: b.cover != null && b.cover.length > 0 }) : null;
  }),

  bind(C.libraryReadBookBytes, async (input) => {
    const book = getBook(getDb(), input.bookId);
    if (!book) throw new Error(`library: book ${input.bookId} not found`);
    return readBookFile(appService.getPath("booksDir"), input.bookId, book.format);
  }),

  bind(C.libraryDelete, (input) =>
    deleteBook(getDb(), appService.getPath("booksDir"), input.bookId),
  ),

  bind(C.libraryUpdate, (input) => {
    const book = updateBook(getDb(), input);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),

  // shelf 数据：toDto 复用保证 hasCover 布尔化等口径一致，percent/lastReadAt 原样透传。
  bind(C.libraryRecentlyRead, () =>
    listRecentlyRead(getDb()).map((r) => ({
      ...toDto(r),
      percent: r.percent,
      lastReadAt: r.lastReadAt,
    })),
  ),

  bind(C.libraryReorder, (input) => reorderBooks(getDb(), input.orderedIds)),

  bind(C.progressGet, (input) => {
    const p = getProgress(getDb(), input.bookId);
    return p ? { locator: p.locator } : null;
  }),

  bind(C.progressSave, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId))
      throw new Error(`progress:save — book ${input.bookId} not found`);
    saveProgress(db, input.bookId, input.locator, input.percent);
  }),

  bind(C.contentToc, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return getToc(db, input.bookId);
  }),

  bind(C.contentChapters, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return listChapters(db, input.bookId);
  }),

  bind(C.contentChapterSummary, (input) =>
    getChapterSummaryView(getDb(), input.bookId, input.chapterId),
  ),

  // 触发本章摘要懒生成（开章自动 / pill 手动按钮）。fire-and-forget：ensureChapterSummary
  // 内部自含 reject 兜底；同步前缀会把状态派生为 generating，故返回当前派生状态即时反馈。
  // force（pill「重新生成」）跳过 ready-skip；自动触发不传——否则每次开章都会重生成已 ready 的摘要。
  // 预检：模型未配置 → reject 带 reason（pill toast 透传；自动触发侧 catch 静默），不再静默装死。
  bind(C.contentGenerateChapterSummary, (input) => {
    const db = getDb();
    const deps = makeSummaryDeps();
    assertSummaryModelReady(deps.resolveModel);
    assertTextLayer(db, input.bookId);
    void ensureChapterSummary(deps, input.bookId, input.chapterId, input.force ?? false).catch(
      (err) => log.warn("generate chapter summary failed", err),
    );
    return getChapterSummaryView(db, input.bookId, input.chapterId);
  }),

  bind(C.contentBookSummary, (input) => getBookSummaryView(getDb(), input.bookId)),

  // 触发全书摘要懒生成（书卡手动按钮）。fire-and-forget；同步前缀置 inFlight，故返回即为 generating。
  bind(C.contentGenerateBookSummary, (input) => {
    const db = getDb();
    const deps = makeSummaryDeps();
    assertSummaryModelReady(deps.resolveModel); // 模型未配置 → reject 带 reason（书卡 toast 透传）
    assertTextLayer(db, input.bookId);
    // force=true：书卡「生成/重新生成」总是（重）生成，覆盖旧摘要。
    void ensureBookSummary(deps, input.bookId, true).catch((err) =>
      log.warn("generate book summary failed", err),
    );
    return getBookSummaryView(db, input.bookId);
  }),

  bind(C.contentChapterText, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`content: book ${input.bookId} not found`);
    // readBookFile 缺失即抛 BookFileMissingError（message 已含 bookId），其他 OS 错误原样透传——
    // 不再包一层「可能缺失/重新导入」的笼统文案（对非缺失错误属编造），与 readBookBytes handler 一致。
    const bytes = await readBookFile(appService.getPath("booksDir"), input.bookId, book.format);
    return await readChapterText(db, bytes, input.bookId, input.chapterId, {
      offset: input.offset,
      maxChars: input.maxChars,
    });
  }),
];

export function registerLibraryHandlers(): void {
  register(libraryBindings);
}
