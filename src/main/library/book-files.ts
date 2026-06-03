import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** ePub 文件缺失（app 自有副本不在派生位置）——供派生 missing 态 / relink 提示。 */
export class EpubFileMissingError extends Error {
  constructor(public readonly bookId: string) {
    super(`epub file missing for book ${bookId}`);
    this.name = "EpubFileMissingError";
  }
}

/**
 * app 自有 ePub 副本的**派生**路径：`booksDir/<sha256(bookId)>.epub`。
 * 不入库（位置由 bookId 确定性派生，符合 DB lifecycle spec §0 / DD-§1.2）。
 * 用 sha256 哈希编码——bookId 可能是 ePub UID（`urn:uuid:…`/`http://…`，含 `:`/`/` 文件系统非法字符）。
 * 编码函数须**永久稳定**（改了旧文件即失联）。
 */
export function storedEpubPath(booksDir: string, bookId: string): string {
  const name = createHash("sha256").update(bookId).digest("hex");
  return path.join(booksDir, `${name}.epub`);
}

/** 复制 ePub 字节进 app 自有位置（覆盖写；relink/重导即重写）。 */
export async function writeEpubFile(
  booksDir: string,
  bookId: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(booksDir, { recursive: true });
  await writeFile(storedEpubPath(booksDir, bookId), bytes);
}

/** 读 app 自有副本；缺失抛 EpubFileMissingError。 */
export async function readEpubFile(booksDir: string, bookId: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(storedEpubPath(booksDir, bookId)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new EpubFileMissingError(bookId);
    throw err;
  }
}

/** best-effort 删除自有副本（删书时调；缺失无害，仅记日志）。 */
export async function deleteEpubFile(booksDir: string, bookId: string): Promise<void> {
  await unlink(storedEpubPath(booksDir, bookId)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") console.warn(`[book-files] unlink ${bookId} failed:`, err);
  });
}
