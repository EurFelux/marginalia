import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";

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
});
