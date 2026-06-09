import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { storedBookPath } from "@main/library/book-files";
import { applyRestore, verifyBookFiles } from "@main/backup/restore";

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
});
