import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type BookFormat = "epub" | "pdf";

/** 书籍文件缺失（app 自有副本不在派生位置）——供派生 missing 态 / relink 提示。 */
export class BookFileMissingError extends Error {
  constructor(public readonly bookId: string) {
    super(`book file missing for book ${bookId}`);
    this.name = "BookFileMissingError";
  }
}

/**
 * app 自有书籍副本的**派生**路径：`booksDir/<sha256(bookId)>.<format>`。
 * 不入库（位置由 bookId+format 确定性派生）。编码函数须**永久稳定**——
 * 改了旧文件即失联；epub 派生与历史 storedEpubPath 逐字节一致。
 */
export function storedBookPath(booksDir: string, bookId: string, format: BookFormat): string {
  const name = createHash("sha256").update(bookId).digest("hex");
  return path.join(booksDir, `${name}.${format}`);
}

/** 复制书籍字节进 app 自有位置（覆盖写；relink/重导即重写）。 */
export async function writeBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(booksDir, { recursive: true });
  await writeFile(storedBookPath(booksDir, bookId, format), bytes);
}

/** 读 app 自有副本；缺失抛 BookFileMissingError。 */
export async function readBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(storedBookPath(booksDir, bookId, format)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new BookFileMissingError(bookId);
    throw err;
  }
}

/** best-effort 删除自有副本（删书时调；缺失无害，仅记日志）。 */
export async function deleteBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
): Promise<void> {
  await unlink(storedBookPath(booksDir, bookId, format)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") console.warn(`[book-files] unlink ${bookId} failed:`, err);
  });
}
