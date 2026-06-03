import { getBooksDir, getDb } from "@main/db/instance";
import { readEpubFile } from "@main/library/book-files";
import { safeStorageEncryptor } from "@main/secrets/safe-storage-encryptor";
import { resolveAssistantModel } from "@main/ai/assistant-model";
import type { SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";

/** (bookId) => 该书 app 自有 ePub 副本字节；缺失抛 EpubFileMissingError。注入 booksDir 以便单测。 */
export function createLoadBytes(booksDir: string): LoadBytes {
  return (bookId: string) => readEpubFile(booksDir, bookId);
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(getBooksDir());
  const resolveModel = () => resolveAssistantModel(db, safeStorageEncryptor);
  return { db, loadBytes, resolveModel };
}

/** 章摘懒生成所需依赖（供 content:generate-chapter-summary handler 用）。 */
export function makeSummaryDeps(): SummaryDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(getBooksDir()),
    resolveModel: () => resolveAssistantModel(db, safeStorageEncryptor),
  };
}
