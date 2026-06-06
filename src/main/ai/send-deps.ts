import { getBooksDir, getDb } from "@main/db/instance";
import { readBookFile } from "@main/library/book-files";
import { getBook } from "@main/library/repository";
import { resolveAssistantModel, resolveSummaryModel } from "@main/ai/assistant-model";
import type { DB } from "@main/db/client";
import type { SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";

/** (bookId) => 该书 app 自有副本字节；缺失抛 BookFileMissingError。注入 db/booksDir 以便单测。 */
export function createLoadBytes(booksDir: string, db: DB): LoadBytes {
  return (bookId: string) => {
    const book = getBook(db, bookId);
    if (!book) throw new Error(`send-deps: book ${bookId} not found`);
    return readBookFile(booksDir, bookId, book.format);
  };
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(getBooksDir(), db);
  const resolveModel = () => resolveAssistantModel(db);
  return { db, loadBytes, resolveModel, resolveSummaryModel: () => resolveSummaryModel(db) };
}

/** 章摘懒生成所需依赖（供 content:generate-chapter-summary handler 用）。
 * 摘要（章节/全书）走独立 resolveSummaryModel（spec §5），不共享聊天模型。 */
export function makeSummaryDeps(): SummaryDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(getBooksDir(), db),
    resolveModel: () => resolveSummaryModel(db),
  };
}
