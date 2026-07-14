import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { storedBookPath } from "@main/library/book-files";
import { exportBackup, inspectBackup, restoreBackup } from "@main/backup/backup-service";
import { latestMigrationDir, listMigrationDirs } from "@main/db/migrations-path";
import { createBackupZip, extractZip } from "@main/backup/archive";

const MIG = path.resolve(process.cwd(), "src/main/db/migrations");
const HEAD = latestMigrationDir(MIG);
const KNOWN = listMigrationDirs(MIG);

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// build a real on-disk source userData (db + one book file), return its db handle + dirs
function makeSource(): { db: DB; dataDir: string; booksDir: string; tmpDir: string } {
  const dataDir = tmp("svc-src-");
  const dbPath = path.join(dataDir, "marginalia.db");
  const db = createDb(dbPath);
  runMigrations(db, MIG);
  db.insert(books).values({ id: "b1", format: "epub" }).run();
  const booksDir = path.join(dataDir, "books");
  mkdirSync(booksDir);
  writeFileSync(storedBookPath(booksDir, "b1", "epub"), "BOOK-BYTES");
  const tmpDir = path.join(dataDir, "tmp");
  return { db, dataDir, booksDir, tmpDir };
}

describe("backup-service roundtrip", () => {
  let src: ReturnType<typeof makeSource>;
  let zipPath: string;
  beforeEach(() => {
    src = makeSource();
    zipPath = path.join(tmp("svc-zip-"), "backup.zip");
  });

  it("exports a zip with a manifest reflecting the library", async () => {
    const res = await exportBackup({
      kind: "full",
      createdAt: 1,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    expect(res.path).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);

    const ins = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(ins.manifest.bookCount).toBe(1);
    expect(ins.manifest.appVersion).toBe("9.9.9");
    expect(ins.manifest.schemaHead).toBe(HEAD);
    expect(ins.manifest.kind).toBe("full");
    expect(ins.manifest.formatVersion).toBe(2);
    expect(ins.compatible).toBe(true);
  });

  it("exports a compact zip without books", async () => {
    await exportBackup({
      kind: "compact",
      createdAt: 2,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });

    const extracted = tmp("svc-compact-extract-");
    await extractZip(zipPath, extracted);
    expect(existsSync(path.join(extracted, "marginalia.db"))).toBe(true);
    expect(existsSync(path.join(extracted, "books"))).toBe(false);
    const inspection = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(inspection.manifest.kind).toBe("compact");
  });

  it("inspect flags an incompatible (newer) backup", async () => {
    await exportBackup({
      kind: "full",
      createdAt: 1,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: "9999_from_the_future",
    });
    const ins = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(ins.compatible).toBe(false);
    expect(ins.reason).toBeTruthy();
  });

  it("restores the bundle into a fresh dataDir and preserves old data", async () => {
    await exportBackup({
      kind: "full",
      createdAt: 1,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    src.db.$client.close();

    // target userData with different existing content
    const dataDir = tmp("svc-dst-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD");
    writeFileSync(storedBookPath(booksDir, "old", "epub"), "OLD-BOOK");
    const tmpDir = path.join(dataDir, "tmp");
    const preRestoreDir = path.join(dataDir, "pre-restore");

    let closed = false;
    await restoreBackup({
      zipPath,
      dataDir,
      booksDir,
      tmpDir,
      preRestoreDir,
      dbFileName: "marginalia.db",
      knownMigrationDirs: KNOWN,
      stamp: "20260609-000000",
      closeDb: () => {
        closed = true;
      },
    });

    expect(closed).toBe(true);
    // restored book file present
    expect(readFileSync(storedBookPath(booksDir, "b1", "epub"), "utf8")).toBe("BOOK-BYTES");
    // restored db opens and has the book
    const restored = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(restored, MIG);
    expect(restored.select().from(books).all().length).toBe(1);
    restored.$client.close();
    // old data preserved under pre-restore/<stamp>
    expect(readFileSync(path.join(preRestoreDir, "20260609-000000", "marginalia.db"), "utf8")).toBe(
      "OLD",
    );
  });

  it("refuses restore on dbSha256 mismatch (corrupt bundle)", async () => {
    // craft a bundle whose manifest.dbSha256 deliberately does not match its db snapshot
    const craft = tmp("svc-corrupt-");
    const snap = path.join(craft, "snap.db");
    const cdb = createDb(snap);
    runMigrations(cdb, MIG);
    cdb.$client.close();
    const cbooks = path.join(craft, "books");
    mkdirSync(cbooks);
    const badZip = path.join(craft, "bad.zip");
    await createBackupZip({
      kind: "full",
      zipPath: badZip,
      snapshotPath: snap,
      booksDir: cbooks,
      manifest: {
        formatVersion: 1,
        appVersion: "x",
        schemaHead: HEAD,
        createdAt: 1,
        bookCount: 0,
        includesApiKeys: true,
        dbSha256: "0".repeat(64), // wrong on purpose
      },
    });

    const dataDir = tmp("svc-corrupt-dst-");
    let closed = false;
    await expect(
      restoreBackup({
        zipPath: badZip,
        dataDir,
        booksDir: path.join(dataDir, "books"),
        tmpDir: path.join(dataDir, "tmp"),
        preRestoreDir: path.join(dataDir, "pre-restore"),
        dbFileName: "marginalia.db",
        knownMigrationDirs: KNOWN,
        stamp: "corrupt",
        closeDb: () => {
          closed = true;
        },
      }),
    ).rejects.toThrow(/checksum mismatch/);
    // refused before touching the live DB / current data
    expect(closed).toBe(false);
    expect(existsSync(path.join(dataDir, "marginalia.db"))).toBe(false);
  });
});
