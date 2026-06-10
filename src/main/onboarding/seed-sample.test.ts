import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";
import { importBook } from "@main/library/repository";

// spy 模式：默认保留真实实现，仅在需要时 mockRejectedValueOnce 模拟失败。
vi.mock("@main/library/repository", { spy: true });

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("maybeSeedSampleBook", () => {
  it("seeds one book in the given language and sets the flag", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "en");
    const rows = db.select().from(books).all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toMatch(/Margin/);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });

  it("seeds the Chinese book when language is zh-CN", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "zh-CN");
    const rows = db.select().from(books).all();
    expect(rows[0].title).toMatch(/页边/);
  });

  it("does not re-import on a second call", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "en");
    await maybeSeedSampleBook(db, "en");
    expect(db.select().from(books).all().length).toBe(1);
  });

  it("does not import when the flag is already set (deleted-sample stays gone)", async () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    await maybeSeedSampleBook(db, "en");
    expect(db.select().from(books).all().length).toBe(0);
  });

  it("leaves the flag unset on import failure, then succeeds on retry", async () => {
    const db = freshDb();
    vi.mocked(importBook).mockRejectedValueOnce(new Error("boom"));

    // 失败一次：不抛、不导入、不置标记
    await expect(maybeSeedSampleBook(db, "en")).resolves.toBeUndefined();
    expect(db.select().from(books).all().length).toBe(0);
    expect(getAppMeta(db, "sampleSeeded")).toBeNull();

    // 下次启动重试（真实 importBook）：成功并置标记
    await maybeSeedSampleBook(db, "en");
    expect(db.select().from(books).all().length).toBe(1);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });
});
