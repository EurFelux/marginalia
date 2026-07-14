import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createContextTools } from "@main/ai/context-tools";
import { type LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const noopLoad: LoadBytes = async () => new Uint8Array();

const READING_KEYS = ["getToc", "readChapterText", "getChapterSummary", "getBookSummary"];
const LIBRARY_KEYS = ["listBooks", "getBook", "getBookNotes", "listAnnotations", "getReadingStats"];
const READING_SESSION_KEYS = ["listReadingSessions", "getReadingReport"];

describe("createContextTools", () => {
  it("reader context (bookId set) exposes both reading and library tools", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const tools = createContextTools({ db, bookId: book.id, loadBytes: noopLoad });
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(READING_KEYS));
    expect(keys).toEqual(expect.arrayContaining(LIBRARY_KEYS));
    expect(keys).toEqual(expect.arrayContaining(READING_SESSION_KEYS));
  });

  it("library context (bookId null) exposes only library tools", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const tools = createContextTools({ db, bookId: null, loadBytes: noopLoad });
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(LIBRARY_KEYS));
    expect(keys).toEqual(expect.arrayContaining(READING_SESSION_KEYS));
    for (const k of READING_KEYS) expect(keys).not.toContain(k);
  });
});
