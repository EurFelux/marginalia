import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { readBookFileResult, storedBookPath } from "@main/library/book-files";
import { exportBackup, inspectBackup, restoreBackup } from "@main/backup/backup-service";
import { latestMigrationDir, listMigrationDirs } from "@main/db/migrations-path";
import { createBackupZip, extractZip, sha256File } from "@main/backup/archive";
import { ZipArchive } from "archiver";

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

  it("normalizes a v1 manifest as a full backup during inspection", async () => {
    const legacyDir = tmp("svc-v1-");
    const snapshotPath = path.join(legacyDir, "marginalia.db");
    const sqlite = createDb(snapshotPath);
    runMigrations(sqlite, MIG);
    sqlite.$client.close();
    const booksDir = path.join(legacyDir, "books");
    mkdirSync(booksDir);
    const legacyZip = path.join(legacyDir, "legacy.zip");
    await createBackupZip({
      kind: "full",
      zipPath: legacyZip,
      snapshotPath,
      booksDir,
      manifest: {
        formatVersion: 1,
        appVersion: "1.0.0",
        schemaHead: HEAD,
        createdAt: 1,
        bookCount: 0,
        includesApiKeys: true,
        dbSha256: "0".repeat(64),
      },
    });

    const inspection = await inspectBackup({ zipPath: legacyZip, knownMigrationDirs: KNOWN });
    expect(inspection.manifest.kind).toBe("full");
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

  it("refuses an archive replaced after compact inspection without touching live data", async () => {
    await exportBackup({
      kind: "compact",
      createdAt: 5,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    const inspection = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(inspection.manifest.kind).toBe("compact");

    // Simulate a full archive replacing the inspected compact archive before confirmation.
    await exportBackup({
      kind: "full",
      createdAt: 6,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });

    const dataDir = tmp("svc-replaced-dst-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "LIVE-DB");
    writeFileSync(storedBookPath(booksDir, "live", "epub"), "LIVE-BOOK");
    let closed = false;

    await expect(
      restoreBackup({
        zipPath,
        archiveSha256: inspection.archiveSha256,
        dataDir,
        booksDir,
        tmpDir: path.join(dataDir, "tmp"),
        preRestoreDir: path.join(dataDir, "pre-restore"),
        dbFileName: "marginalia.db",
        knownMigrationDirs: KNOWN,
        stamp: "replaced",
        closeDb: () => {
          closed = true;
        },
      }),
    ).rejects.toThrow(/archive checksum changed/);

    expect(closed).toBe(false);
    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("LIVE-DB");
    expect(readFileSync(storedBookPath(booksDir, "live", "epub"), "utf8")).toBe("LIVE-BOOK");
  });

  it("keeps compact semantics when a payload entry is named archive.zip", async () => {
    const craft = tmp("svc-nested-archive-");
    const nestedFullZip = path.join(craft, "nested-full.zip");
    await exportBackup({
      kind: "full",
      createdAt: 7,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath: nestedFullZip,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    const nestedPayload = path.join(craft, "nested-payload");
    await extractZip(nestedFullZip, nestedPayload);
    const nestedDb = path.join(nestedPayload, "marginalia.db");
    const outerZip = path.join(craft, "outer-compact.zip");
    const compactManifest = {
      formatVersion: 2,
      kind: "compact",
      appVersion: "9.9.9",
      schemaHead: HEAD,
      createdAt: 8,
      bookCount: 1,
      includesApiKeys: true,
      dbSha256: await sha256File(nestedDb),
    };
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outerZip);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.file(nestedDb, { name: "marginalia.db" });
      archive.directory(path.join(nestedPayload, "books"), "books");
      archive.append(JSON.stringify(compactManifest), { name: "manifest.json" });
      archive.file(nestedFullZip, { name: "archive.zip" });
      void archive.finalize();
    });
    const inspection = await inspectBackup({ zipPath: outerZip, knownMigrationDirs: KNOWN });
    expect(inspection.manifest.kind).toBe("compact");

    const dataDir = tmp("svc-nested-archive-dst-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "LIVE-DB");
    writeFileSync(storedBookPath(booksDir, "live", "epub"), "LIVE-BOOK");
    const preRestoreDir = path.join(dataDir, "pre-restore");

    await restoreBackup({
      zipPath: outerZip,
      archiveSha256: inspection.archiveSha256,
      dataDir,
      booksDir,
      tmpDir: path.join(dataDir, "tmp"),
      preRestoreDir,
      dbFileName: "marginalia.db",
      knownMigrationDirs: KNOWN,
      stamp: "nested-archive",
      closeDb: () => {},
    });

    expect(readFileSync(storedBookPath(booksDir, "live", "epub"), "utf8")).toBe("LIVE-BOOK");
    expect(existsSync(storedBookPath(booksDir, "b1", "epub"))).toBe(false);
    expect(existsSync(path.join(preRestoreDir, "nested-archive", "books"))).toBe(false);
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
      archiveSha256: await sha256File(zipPath),
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

  it("compact restore replaces the DB and preserves all local book files", async () => {
    await exportBackup({
      kind: "compact",
      createdAt: 3,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    src.db.$client.close();

    const dataDir = tmp("svc-compact-dst-");
    const oldDb = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(oldDb, MIG);
    oldDb.insert(books).values({ id: "old", format: "epub" }).run();
    oldDb.$client.close();
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(storedBookPath(booksDir, "b1", "epub"), "LOCAL-B1");
    writeFileSync(storedBookPath(booksDir, "orphan", "epub"), "LOCAL-ORPHAN");
    const preRestoreDir = path.join(dataDir, "pre-restore");
    const stamp = "compact-swap";

    await restoreBackup({
      zipPath,
      archiveSha256: await sha256File(zipPath),
      dataDir,
      booksDir,
      tmpDir: path.join(dataDir, "tmp"),
      preRestoreDir,
      dbFileName: "marginalia.db",
      knownMigrationDirs: KNOWN,
      stamp,
      closeDb: () => {},
    });

    const restored = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(restored, MIG);
    expect(
      restored
        .select()
        .from(books)
        .all()
        .map((book) => book.id),
    ).toEqual(["b1"]);
    restored.$client.close();
    expect(readFileSync(storedBookPath(booksDir, "b1", "epub"), "utf8")).toBe("LOCAL-B1");
    expect(readFileSync(storedBookPath(booksDir, "orphan", "epub"), "utf8")).toBe("LOCAL-ORPHAN");
    expect(existsSync(path.join(preRestoreDir, stamp, "marginalia.db"))).toBe(true);
    expect(existsSync(path.join(preRestoreDir, stamp, "books"))).toBe(false);
  });

  it("compact restore reuses the existing missing-file fallback", async () => {
    await exportBackup({
      kind: "compact",
      createdAt: 4,
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    src.db.$client.close();

    const dataDir = tmp("svc-compact-missing-");
    const oldDb = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(oldDb, MIG);
    oldDb.$client.close();
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);

    await restoreBackup({
      zipPath,
      archiveSha256: await sha256File(zipPath),
      dataDir,
      booksDir,
      tmpDir: path.join(dataDir, "tmp"),
      preRestoreDir: path.join(dataDir, "pre-restore"),
      dbFileName: "marginalia.db",
      knownMigrationDirs: KNOWN,
      stamp: "compact-missing",
      closeDb: () => {},
    });

    const restored = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(restored, MIG);
    expect(
      restored
        .select()
        .from(books)
        .all()
        .map((book) => book.id),
    ).toContain("b1");
    restored.$client.close();
    await expect(readBookFileResult(booksDir, "b1", "epub")).resolves.toEqual({
      ok: false,
      error: { reason: "missing" },
    });
  });

  it("refuses restore on dbSha256 mismatch (corrupt bundle)", async () => {
    // craft a bundle whose manifest.dbSha256 deliberately does not match its db snapshot
    const craft = tmp("svc-corrupt-");
    const snap = path.join(craft, "snap.db");
    const cdb = createDb(snap);
    runMigrations(cdb, MIG);
    cdb.$client.close();
    const badZip = path.join(craft, "bad.zip");
    await createBackupZip({
      kind: "compact",
      zipPath: badZip,
      snapshotPath: snap,
      manifest: {
        formatVersion: 2,
        kind: "compact",
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
        archiveSha256: await sha256File(badZip),
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
