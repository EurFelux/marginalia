import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { storedBookPath } from "@main/library/book-files";
import { applyRestore, verifyBookFiles, verifySqliteDatabase } from "@main/backup/restore";

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
function seedDb(file: string, books: { id: string; format: string }[]): void {
  const db = new Database(file);
  db.exec("create table books (id text primary key, format text not null default 'epub')");
  const ins = db.prepare("insert into books (id, format) values (?, ?)");
  for (const b of books) ins.run(b.id, b.format);
  db.close();
}

describe("verifyBookFiles", () => {
  it("ok when every book row has its file", () => {
    const dir = tmp("ver-ok-");
    const dbFile = path.join(dir, "marginalia.db");
    seedDb(dbFile, [{ id: "b1", format: "epub" }]);
    const booksDir = path.join(dir, "books");
    mkdirSync(booksDir);
    writeFileSync(storedBookPath(booksDir, "b1", "epub"), "x");
    expect(verifyBookFiles(dbFile, booksDir)).toEqual({ ok: true, missing: [] });
  });

  it("reports missing book ids", () => {
    const dir = tmp("ver-miss-");
    const dbFile = path.join(dir, "marginalia.db");
    seedDb(dbFile, [
      { id: "b1", format: "epub" },
      { id: "b2", format: "pdf" },
    ]);
    const booksDir = path.join(dir, "books");
    mkdirSync(booksDir);
    writeFileSync(storedBookPath(booksDir, "b1", "epub"), "x");
    expect(verifyBookFiles(dbFile, booksDir)).toEqual({ ok: false, missing: ["b2"] });
  });
});

describe("verifySqliteDatabase", () => {
  it("quick-check accepts SQLite and rejects a non-database file", () => {
    const dir = tmp("quick-check-");
    const dbFile = path.join(dir, "ok.db");
    seedDb(dbFile, []);
    expect(() => verifySqliteDatabase(dbFile)).not.toThrow();
    const badFile = path.join(dir, "bad.db");
    writeFileSync(badFile, "not sqlite");
    expect(() => verifySqliteDatabase(badFile)).toThrow(/integrity check/i);
  });
});

describe("applyRestore", () => {
  it("moves current data to pre-restore and staged into place", async () => {
    const dataDir = tmp("ar-data-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
    writeFileSync(path.join(booksDir, "old.epub"), "OLD-BOOK");

    const stagingDir = tmp("ar-stage-");
    writeFileSync(path.join(stagingDir, "marginalia.db"), "NEW-DB");
    const stagedBooks = path.join(stagingDir, "books");
    mkdirSync(stagedBooks);
    writeFileSync(path.join(stagedBooks, "new.epub"), "NEW-BOOK");

    const preRestoreTarget = path.join(tmp("ar-pre-"), "snap");

    await applyRestore({
      kind: "full",
      dataDir,
      booksDir,
      stagingDir,
      preRestoreTarget,
      dbFileName: "marginalia.db",
    });

    // current replaced by staged
    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("NEW-DB");
    expect(readFileSync(path.join(booksDir, "new.epub"), "utf8")).toBe("NEW-BOOK");
    expect(existsSync(path.join(booksDir, "old.epub"))).toBe(false);
    // old preserved in pre-restore
    expect(readFileSync(path.join(preRestoreTarget, "marginalia.db"), "utf8")).toBe("OLD-DB");
    expect(readFileSync(path.join(preRestoreTarget, "books", "old.epub"), "utf8")).toBe("OLD-BOOK");
  });

  it("compact restore replaces only DB files and preserves books in place", async () => {
    const dataDir = tmp("ar-compact-data-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
    writeFileSync(path.join(dataDir, "marginalia.db-wal"), "OLD-WAL");
    writeFileSync(path.join(booksDir, "keep.epub"), "KEEP-BOOK");

    const stagingDir = tmp("ar-compact-stage-");
    writeFileSync(path.join(stagingDir, "marginalia.db"), "NEW-DB");
    const preRestoreTarget = path.join(tmp("ar-compact-pre-"), "snap");

    await applyRestore({
      kind: "compact",
      dataDir,
      booksDir,
      stagingDir,
      preRestoreTarget,
      dbFileName: "marginalia.db",
    });

    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("NEW-DB");
    expect(readFileSync(path.join(booksDir, "keep.epub"), "utf8")).toBe("KEEP-BOOK");
    expect(readFileSync(path.join(preRestoreTarget, "marginalia.db"), "utf8")).toBe("OLD-DB");
    expect(readFileSync(path.join(preRestoreTarget, "marginalia.db-wal"), "utf8")).toBe("OLD-WAL");
    expect(existsSync(path.join(preRestoreTarget, "books"))).toBe(false);
  });

  it("rolls back a compact swap when installing the staged database fails", async () => {
    const dataDir = tmp("ar-compact-rollback-data-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
    writeFileSync(path.join(dataDir, "marginalia.db-wal"), "OLD-WAL");
    writeFileSync(path.join(booksDir, "keep.epub"), "KEEP-BOOK");
    const stagingDir = tmp("ar-compact-rollback-stage-");
    const stagedDb = path.join(stagingDir, "marginalia.db");
    writeFileSync(stagedDb, "NEW-DB");
    const preRestoreTarget = path.join(tmp("ar-compact-rollback-pre-"), "snap");
    const move = vi.fn(async (source: string, destination: string) => {
      if (source === stagedDb && destination === path.join(dataDir, "marginalia.db")) {
        throw new Error("injected staged database failure");
      }
      await rename(source, destination);
    });

    await expect(
      applyRestore({
        kind: "compact",
        dataDir,
        booksDir,
        stagingDir,
        preRestoreTarget,
        dbFileName: "marginalia.db",
        rename: move,
      }),
    ).rejects.toThrow(/injected staged database failure/);

    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("OLD-DB");
    expect(readFileSync(path.join(dataDir, "marginalia.db-wal"), "utf8")).toBe("OLD-WAL");
    expect(readFileSync(path.join(booksDir, "keep.epub"), "utf8")).toBe("KEEP-BOOK");
    expect(move).not.toHaveBeenCalledWith(booksDir, expect.any(String));
  });

  it("rolls back a full swap when installing staged books fails", async () => {
    const dataDir = tmp("ar-full-rollback-data-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
    writeFileSync(path.join(booksDir, "old.epub"), "OLD-BOOK");
    const stagingDir = tmp("ar-full-rollback-stage-");
    writeFileSync(path.join(stagingDir, "marginalia.db"), "NEW-DB");
    const stagedBooks = path.join(stagingDir, "books");
    mkdirSync(stagedBooks);
    writeFileSync(path.join(stagedBooks, "new.epub"), "NEW-BOOK");
    const preRestoreTarget = path.join(tmp("ar-full-rollback-pre-"), "snap");
    const move = vi.fn(async (source: string, destination: string) => {
      if (source === stagedBooks && destination === booksDir) {
        throw new Error("injected staged books failure");
      }
      await rename(source, destination);
    });

    await expect(
      applyRestore({
        kind: "full",
        dataDir,
        booksDir,
        stagingDir,
        preRestoreTarget,
        dbFileName: "marginalia.db",
        rename: move,
      }),
    ).rejects.toThrow(/injected staged books failure/);

    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("OLD-DB");
    expect(readFileSync(path.join(booksDir, "old.epub"), "utf8")).toBe("OLD-BOOK");
  });
});
