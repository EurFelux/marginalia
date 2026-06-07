import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { getProgress, saveProgress } from "@main/library/progress";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = async () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  return { db, book };
};

describe("progress repository", () => {
  it("returns undefined when nothing saved", async () => {
    const { db, book } = await setup();
    expect(getProgress(db, book.id)).toBeUndefined();
  });
  it("upserts locator", async () => {
    const { db, book } = await setup();
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)");
    expect(getProgress(db, book.id)?.locator).toBe("epubcfi(/6/2!/4/1:0)");
    saveProgress(db, book.id, "epubcfi(/6/4!/4/1:0)");
    expect(getProgress(db, book.id)?.locator).toBe("epubcfi(/6/4!/4/1:0)");
  });

  it("saves percent and overwrites it on update (null when omitted)", async () => {
    const { db, book } = await setup();
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 0);
    expect(getProgress(db, book.id)?.percent).toBe(0);
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 1);
    expect(getProgress(db, book.id)?.percent).toBe(1);
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 0.25);
    expect(getProgress(db, book.id)?.percent).toBe(0.25);
    saveProgress(db, book.id, "epubcfi(/6/4!/4/1:0)", 0.5);
    expect(getProgress(db, book.id)?.percent).toBe(0.5);
    // 不带 percent 的保存把旧值抹成 null——locator 与 percent 是同一位置的快照，留旧值即脏数据
    saveProgress(db, book.id, "epubcfi(/6/6!/4/1:0)");
    expect(getProgress(db, book.id)?.percent).toBeNull();
  });

  it("rejects out-of-range percent via DB CHECK", async () => {
    const { db, book } = await setup();
    expect(() => saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 1.5)).toThrow(/check/i);
    expect(() => saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", -0.1)).toThrow(/check/i);
  });
});
