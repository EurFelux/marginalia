// src/main/ai/context-tools.ts —— 按上下文组装"上下文工具集"（spec 2026-06-16-reader-library-tools §3.2）。
// reader（bookId 非空）= 阅读工具 + 书库工具；library（bookId 为 null）= 仅书库工具。
// memory / search 工具在 stream-assistant 另行合并（各有门控），不在此处。
import type { DB } from "@main/db/client";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import { createLibraryTools } from "@main/ai/library-tools";

export interface ContextToolsDeps {
  db: DB;
  /** null = 书库上下文；非空 = 阅读器上下文（当前书 id）。 */
  bookId: string | null;
  loadBytes: LoadBytes;
  /** provider 是否支持图像 tool result（透传给 reading 工具的 readPage 门控）。 */
  imageToolResults?: boolean;
}

export function createContextTools(deps: ContextToolsDeps) {
  const { db, bookId, loadBytes, imageToolResults } = deps;
  const library = createLibraryTools({ db });
  if (bookId == null) return library;
  return {
    ...createReadingTools({ db, bookId, loadBytes, imageToolResults }),
    ...library,
  };
}
