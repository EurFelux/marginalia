import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { getProgress, saveProgress } from "@main/library/progress";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = importBook(db, { bytes: makeFixtureEpub() });
  return { db, book };
};

describe("progress repository", () => {
  it("returns undefined when nothing saved", () => {
    const { db, book } = setup();
    expect(getProgress(db, book.id)).toBeUndefined();
  });
  it("upserts locator", () => {
    const { db, book } = setup();
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)");
    expect(getProgress(db, book.id)?.locator).toBe("epubcfi(/6/2!/4/1:0)");
    saveProgress(db, book.id, "epubcfi(/6/4!/4/1:0)");
    expect(getProgress(db, book.id)?.locator).toBe("epubcfi(/6/4!/4/1:0)");
  });
});
