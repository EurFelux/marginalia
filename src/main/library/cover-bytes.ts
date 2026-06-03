import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";

/** 按 magic bytes 嗅探图片 content-type（epub-parser 只给封面字节、不给 MIME，故读时判）。 */
export function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

/** 读某书封面字节 + content-type（注入 db）。无此书 / 无封面 → null。`cover://` 协议 handler 用。 */
export function coverResponseFor(
  db: DB,
  bookId: string,
): { bytes: Uint8Array; contentType: string } | null {
  const row = db.select({ cover: books.cover }).from(books).where(eq(books.id, bookId)).get();
  if (!row?.cover || row.cover.length === 0) return null;
  const bytes = new Uint8Array(row.cover);
  return { bytes, contentType: sniffImageType(bytes) };
}
