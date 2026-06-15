import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DB } from "@main/db/client";
import { blob } from "@main/db/schema";

/** 写入一条 blob，返回新 id。data 为原始字节，mimeType 由调用方（写入时嗅探）提供。 */
export function writeBlob(db: DB, data: Uint8Array, mimeType: string): string {
  const id = uuidv7();
  db.insert(blob)
    .values({ id, data: Buffer.from(data), mimeType, createdAt: Date.now() })
    .run();
  return id;
}

/** 删除一条 blob（缺失无害）。 */
export function deleteBlob(db: DB, id: string): void {
  db.delete(blob).where(eq(blob.id, id)).run();
}

/** 读一条 blob 的字节 + content-type（media:// 协议 handler 用）。无此 id → null。 */
export function blobResponseFor(
  db: DB,
  id: string,
): { bytes: Uint8Array; contentType: string } | null {
  const row = db
    .select({ data: blob.data, mimeType: blob.mimeType })
    .from(blob)
    .where(eq(blob.id, id))
    .get();
  if (!row?.data) return null;
  return { bytes: new Uint8Array(row.data), contentType: row.mimeType };
}
