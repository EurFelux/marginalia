import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { DB } from "@main/db/client";
import { createLogger } from "@main/logger";
import {
  backupManifestSchema,
  type BackupKind,
  type BackupExportResult,
  type BackupInspection,
} from "@shared/backup";
import { buildManifest } from "@main/backup/manifest";
import { checkRestoreCompatibility } from "@main/backup/compat";
import { createBackupZip, extractZip, readZipEntryText, sha256File } from "@main/backup/archive";
import { applyRestore, verifyBookFiles } from "@main/backup/restore";

const log = createLogger("backup");

/** 导出：.backup() 一致快照 → 算 sha256 → buildManifest → 流式 zip → 清临时。 */
export async function exportBackup(opts: {
  kind: BackupKind;
  createdAt: number;
  db: DB;
  rawSqlite: Database.Database;
  zipPath: string;
  booksDir: string;
  tmpDir: string;
  appVersion: string;
  schemaHead: string;
}): Promise<BackupExportResult> {
  await mkdir(opts.tmpDir, { recursive: true });
  const snapshotPath = path.join(opts.tmpDir, `export-${opts.createdAt}.db`);
  try {
    await opts.rawSqlite.backup(snapshotPath);
    const dbSha256 = await sha256File(snapshotPath);
    const manifest = buildManifest(opts.db, {
      kind: opts.kind,
      appVersion: opts.appVersion,
      schemaHead: opts.schemaHead,
      dbSha256,
      createdAt: opts.createdAt,
    });
    const archiveBase = {
      zipPath: opts.zipPath,
      snapshotPath,
      manifest,
    };
    await createBackupZip(
      opts.kind === "full"
        ? { ...archiveBase, kind: "full", booksDir: opts.booksDir }
        : { ...archiveBase, kind: "compact" },
    );
    return { path: opts.zipPath };
  } finally {
    await unlink(snapshotPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") log.warn("export temp cleanup failed", e);
    });
  }
}

/** 检视：读 manifest.json → Zod 校验 → 兼容性判定。 */
export async function inspectBackup(opts: {
  zipPath: string;
  knownMigrationDirs: string[];
}): Promise<BackupInspection> {
  const raw = await readZipEntryText(opts.zipPath, "manifest.json");
  const manifest = backupManifestSchema.parse(JSON.parse(raw));
  const { compatible, reason } = checkRestoreCompatibility(
    manifest.schemaHead,
    opts.knownMigrationDirs,
  );
  return { path: opts.zipPath, manifest, compatible, reason };
}

/** 还原（整体替换）：解包到 staging → 校验完整性/兼容性 → closeDb → applyRestore。relaunch 由 handler 做。 */
export async function restoreBackup(opts: {
  zipPath: string;
  dataDir: string;
  booksDir: string;
  tmpDir: string;
  preRestoreDir: string;
  dbFileName: string;
  knownMigrationDirs: string[];
  stamp: string;
  closeDb: () => void;
}): Promise<void> {
  const stagingDir = path.join(opts.tmpDir, `restore-${opts.stamp}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await extractZip(opts.zipPath, stagingDir);

    // 兼容性（manifest 必在、schemaHead 已知）
    const manifestRaw = await readZipEntryText(opts.zipPath, "manifest.json");
    const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw));
    const compat = checkRestoreCompatibility(manifest.schemaHead, opts.knownMigrationDirs);
    if (!compat.compatible) throw new Error(`restore refused: ${compat.reason}`);

    // 完整性：db sha256 + 书文件齐全
    const stagedDb = path.join(stagingDir, opts.dbFileName);
    const stagedBooks = path.join(stagingDir, "books");
    const sha = await sha256File(stagedDb);
    if (sha !== manifest.dbSha256) {
      throw new Error("restore refused: backup database checksum mismatch (corrupt bundle)");
    }
    const books = verifyBookFiles(stagedDb, stagedBooks);
    if (!books.ok) {
      throw new Error(`restore refused: backup is missing book files: ${books.missing.join(", ")}`);
    }

    // 换库前关连接释放锁，再整体替换
    const preRestoreTarget = path.join(opts.preRestoreDir, opts.stamp);
    opts.closeDb();
    try {
      await applyRestore({
        dataDir: opts.dataDir,
        booksDir: opts.booksDir,
        stagingDir,
        preRestoreTarget,
        dbFileName: opts.dbFileName,
      });
    } catch (err) {
      log.error(`restore failed mid-swap; original data preserved at ${preRestoreTarget}`, err);
      throw new Error(
        `Restore failed while swapping files. Your original data is preserved at ${preRestoreTarget} — copy marginalia.db and the books folder from there back into the app data folder to recover.`,
      );
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") log.warn("restore staging cleanup failed", e);
    });
  }
}
