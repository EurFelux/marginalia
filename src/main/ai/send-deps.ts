import { readFile } from "node:fs/promises";
import type { DB } from "@main/db/client";
import { getDb } from "@main/db/instance";
import { getBook } from "@main/library/repository";
import { safeStorageEncryptor } from "@main/secrets/safe-storage-encryptor";
import { resolveAssistantModel } from "@main/ai/assistant-model";
import { ensureChapterSummary, type SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";

/** (bookId) => 该书 ePub 原始字节；book 不存在则抛。可注入 db 以便单测。 */
export function createLoadBytes(db: DB): LoadBytes {
  return async (bookId: string) => {
    const book = getBook(db, bookId);
    if (!book) throw new Error(`send-deps: book ${bookId} not found`);
    const buf = await readFile(book.path);
    return new Uint8Array(buf);
  };
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(db);
  const resolveModel = () => resolveAssistantModel(db, safeStorageEncryptor);
  const summaryDeps: SummaryDeps = { db, loadBytes, resolveModel };
  const ensureSummary = (bookId: string, chapterId: string): void => {
    // fire-and-forget：自含 reject，杜绝 unhandledRejection
    void ensureChapterSummary(summaryDeps, bookId, chapterId).catch((err) => {
      console.warn("[send-deps] ensureChapterSummary failed:", err);
    });
  };
  return { db, loadBytes, resolveModel, ensureSummary };
}
