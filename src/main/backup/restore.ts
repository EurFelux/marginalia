import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { storedBookPath, type BookFormat } from "@main/library/book-files";
import type { BackupKind } from "@shared/backup";

/** 校验 staged DB 引用的每本书文件在 staged books/ 中存在；返回缺失 bookId 列表。 */
export function verifyBookFiles(
  stagedDbPath: string,
  stagedBooksDir: string,
): { ok: boolean; missing: string[] } {
  const sqlite = new Database(stagedDbPath, { readonly: true });
  try {
    const rows = sqlite.prepare("select id, format from books").all() as {
      id: string;
      format: string;
    }[];
    const missing = rows
      .filter((r) => !existsSync(storedBookPath(stagedBooksDir, r.id, r.format as BookFormat)))
      .map((r) => r.id);
    return { ok: missing.length === 0, missing };
  } finally {
    sqlite.close();
  }
}

/** 以只读连接执行 SQLite quick_check，拒绝损坏或非 SQLite 数据库。 */
export function verifySqliteDatabase(dbFile: string): void {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
    const result = sqlite.prepare("PRAGMA quick_check").pluck().all() as string[];
    if (result.length !== 1 || result[0] !== "ok") {
      throw new Error(`database integrity check failed: ${result.join(", ")}`);
    }
  } catch (err) {
    if (err instanceof Error && /integrity check/.test(err.message)) throw err;
    throw new Error("database integrity check failed", { cause: err });
  } finally {
    sqlite?.close();
  }
}

/**
 * Snapshot replacement: full archives move DB + books into preRestoreTarget and replace both;
 * compact archives move only the DB three-piece and leave books untouched.
 * staging 与 dataDir 同盘（userData/tmp），rename 不跨设备。调用前须已 closeDb() 释放锁。
 */
export async function applyRestore(opts: {
  kind: BackupKind;
  dataDir: string;
  booksDir: string;
  stagingDir: string;
  preRestoreTarget: string;
  dbFileName: string;
}): Promise<void> {
  await mkdir(opts.preRestoreTarget, { recursive: true });

  // 1) 当前数据 → pre-restore 安全副本
  for (const f of [opts.dbFileName, `${opts.dbFileName}-wal`, `${opts.dbFileName}-shm`]) {
    const src = path.join(opts.dataDir, f);
    if (existsSync(src)) await rename(src, path.join(opts.preRestoreTarget, f));
  }
  if (opts.kind === "full" && existsSync(opts.booksDir)) {
    await rename(opts.booksDir, path.join(opts.preRestoreTarget, "books"));
  }

  // 2) staged → 正式位置
  await rename(
    path.join(opts.stagingDir, opts.dbFileName),
    path.join(opts.dataDir, opts.dbFileName),
  );
  if (opts.kind === "full") {
    const stagedBooks = path.join(opts.stagingDir, "books");
    if (existsSync(stagedBooks)) await rename(stagedBooks, opts.booksDir);
  }
}
