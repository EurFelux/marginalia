import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { createLoadBytes } from "@main/ai/send-deps";
import { importBook } from "@main/library/repository";
import { storedBookPath } from "@main/library/book-files";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("createLoadBytes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-send-deps-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads bytes for a book whose file exists", async () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub() });
    const expectedBytes = new Uint8Array([1, 2, 3]);
    await writeFile(storedBookPath(dir, book.id, book.format), expectedBytes);

    const loadBytes = createLoadBytes(dir, db);
    const bytes = await loadBytes(book.id);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("throws BookFileMissingError for a book whose file is absent", async () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub() });
    // 书行存在但文件未写入
    const loadBytes = createLoadBytes(dir, db);
    const { BookFileMissingError } = await import("@main/library/book-files");
    await expect(loadBytes(book.id)).rejects.toBeInstanceOf(BookFileMissingError);
  });

  it("rejects when the book does not exist in DB", async () => {
    const db = freshDb();
    const loadBytes = createLoadBytes(dir, db);
    // async 闭包统一错误通道：同步 throw 也必须以 rejected promise 形式暴露
    await expect(loadBytes("nonexistent-id")).rejects.toThrow("not found");
  });
});
