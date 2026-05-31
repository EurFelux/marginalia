import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { getBook, importBook, listBooks, resolveChapterByHref } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("library repository", () => {
  it("imports a book and persists metadata + ordered chapters (pending)", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub(), filePath: "/books/fixture.epub" });
    expect(book.id).toBe("urn:uuid:fixture-001");
    expect(book.title).toBe("Fixture Book");
    expect(getBook(db, book.id)?.path).toBe("/books/fixture.epub");
    expect(listBooks(db)).toHaveLength(1);

    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml");
    const ch2 = resolveChapterByHref(db, book.id, "OEBPS/ch2.xhtml");
    expect(ch1?.orderIndex).toBe(0);
    expect(ch2?.orderIndex).toBe(1);
    expect(ch1?.title).toBe("Chapter One");
    expect(ch1?.summaryStatus).toBe("pending");
    expect(ch1?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a content-hash id when the epub has no identifier", () => {
    const db = freshDb();
    const book = importBook(db, {
      bytes: makeFixtureEpub({ identifier: null }),
      filePath: "/no-id.epub",
    });
    expect(book.id).toMatch(/^[0-9a-f]{64}$/);
    expect(getBook(db, book.id)).toBeDefined();
  });

  it("idempotent import: re-importing the same epub does not create duplicate books or change chapter ids", () => {
    const db = freshDb();
    const bytes = makeFixtureEpub();

    const book1 = importBook(db, { bytes, filePath: "/books/fixture.epub" });
    const ch1AfterFirst = resolveChapterByHref(db, book1.id, "OEBPS/ch1.xhtml");
    const ch1Id = ch1AfterFirst?.id;

    // Second import of the same bytes
    const book2 = importBook(db, { bytes, filePath: "/books/fixture.epub" });

    expect(listBooks(db)).toHaveLength(1);
    const ch1AfterSecond = resolveChapterByHref(db, book2.id, "OEBPS/ch1.xhtml");
    expect(ch1AfterSecond?.id).toBe(ch1Id);
    // Chapter rows must not double up (fixture has 2 spine items)
    expect(db.select().from(chapters).all()).toHaveLength(2);
  });

  it("resolveChapterByHref returns undefined for a missing href", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub(), filePath: "/books/fixture.epub" });
    expect(resolveChapterByHref(db, book.id, "OEBPS/nonexistent.xhtml")).toBeUndefined();
  });
});
