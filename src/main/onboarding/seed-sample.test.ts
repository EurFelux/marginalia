import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { importBook } from "@main/library/repository";
import { readBookFile } from "@main/library/book-files";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// spy 模式：默认保留真实实现，仅在需要时 mockRejectedValueOnce 模拟失败。
vi.mock("@main/library/repository", { spy: true });

const tmpDirs: string[] = [];
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}
function freshBooksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-seed-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("maybeSeedSampleBook", () => {
  it("seeds one book in the given language, writes its file, and sets the flag", async () => {
    const db = freshDb();
    const booksDir = freshBooksDir();
    await maybeSeedSampleBook(db, "en", booksDir);
    const rows = db.select().from(books).all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toMatch(/Margin/);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
    // 关键回归守卫：磁盘文件副本已写入，可被 reader 路径读回。
    const bytes = await readBookFile(booksDir, rows[0].id, "epub");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("seeds the Chinese book when language is zh-CN", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "zh-CN", freshBooksDir());
    const rows = db.select().from(books).all();
    expect(rows[0].title).toMatch(/页边/);
  });

  it("does not re-import on a second call", async () => {
    const db = freshDb();
    const booksDir = freshBooksDir();
    await maybeSeedSampleBook(db, "en", booksDir);
    await maybeSeedSampleBook(db, "en", booksDir);
    expect(db.select().from(books).all().length).toBe(1);
  });

  it("does not import when the flag is already set (deleted-sample stays gone)", async () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    await maybeSeedSampleBook(db, "en", freshBooksDir());
    expect(db.select().from(books).all().length).toBe(0);
  });

  it("leaves the flag unset on import failure, then succeeds on retry", async () => {
    const db = freshDb();
    const booksDir = freshBooksDir();
    vi.mocked(importBook).mockRejectedValueOnce(new Error("boom"));

    await expect(maybeSeedSampleBook(db, "en", booksDir)).resolves.toBeUndefined();
    expect(db.select().from(books).all().length).toBe(0);
    expect(getAppMeta(db, "sampleSeeded")).toBeNull();

    await maybeSeedSampleBook(db, "en", booksDir);
    expect(db.select().from(books).all().length).toBe(1);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });
});
