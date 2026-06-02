import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";

/**
 * 读取某书的原始 ePub 字节（渲染层 epubjs 解析用）。
 * 纯函数（注入 DB），镜像 send-deps.ts 的 createLoadBytes 取字节模式。
 */
export async function readBookBytes(db: DB, bookId: string): Promise<Uint8Array> {
  const book = db.select({ path: books.path }).from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error(`readBookBytes: book ${bookId} not found`);
  const buf = await readFile(book.path);
  return new Uint8Array(buf);
}
