import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import {
  annotations,
  assistants,
  books,
  chapters,
  conversations,
  messages,
  progress,
} from "@main/db/schema";
import {
  deleteBook,
  getBook,
  importBook,
  listBooks,
  resolveChapterByHref,
} from "@main/library/repository";
import { storedEpubPath } from "@main/library/book-files";
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
    const book = importBook(db, { bytes: makeFixtureEpub() });
    expect(book.id).toBe("urn:uuid:fixture-001");
    expect(book.title).toBe("Fixture Book");
    expect(listBooks(db)).toHaveLength(1);

    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml");
    const ch2 = resolveChapterByHref(db, book.id, "OEBPS/ch2.xhtml");
    expect(ch1?.orderIndex).toBe(0);
    expect(ch2?.orderIndex).toBe(1);
    expect(ch1?.title).toBe("Chapter One");
    expect(ch1?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a content-hash id when the epub has no identifier", () => {
    const db = freshDb();
    const book = importBook(db, {
      bytes: makeFixtureEpub({ identifier: null }),
    });
    expect(book.id).toMatch(/^[0-9a-f]{64}$/);
    expect(getBook(db, book.id)).toBeDefined();
  });

  it("idempotent import: re-importing the same epub does not create duplicate books or change chapter ids", () => {
    const db = freshDb();
    const bytes = makeFixtureEpub();

    const book1 = importBook(db, { bytes });
    const ch1AfterFirst = resolveChapterByHref(db, book1.id, "OEBPS/ch1.xhtml");
    const ch1Id = ch1AfterFirst?.id;

    // Second import of the same bytes
    const book2 = importBook(db, { bytes });

    expect(listBooks(db)).toHaveLength(1);
    const ch1AfterSecond = resolveChapterByHref(db, book2.id, "OEBPS/ch1.xhtml");
    expect(ch1AfterSecond?.id).toBe(ch1Id);
    // Chapter rows must not double up (fixture has 2 spine items)
    expect(db.select().from(chapters).all()).toHaveLength(2);
  });

  it("resolveChapterByHref returns undefined for a missing href", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub() });
    expect(resolveChapterByHref(db, book.id, "OEBPS/nonexistent.xhtml")).toBeUndefined();
  });

  it("ON DELETE CASCADE removes all book-owned dependents", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub() });
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const assistantId = db.insert(assistants).values({ name: "A" }).returning().get().id;
    db.insert(progress).values({ bookId: book.id, cfi: "epubcfi(/6/2)" }).run();
    db.insert(annotations)
      .values({ bookId: book.id, style: "yellow", selectedText: "x", cfiRange: "r" })
      .run();
    const conv = db
      .insert(conversations)
      .values({ bookId: book.id, chapterId: ch1.id, assistantId })
      .returning()
      .get();
    db.insert(messages).values({ conversationId: conv.id, role: "user", parts: [], seq: 0 }).run();

    db.delete(books).where(eq(books.id, book.id)).run();

    expect(listBooks(db)).toHaveLength(0);
    expect(db.select().from(chapters).all()).toHaveLength(0);
    expect(db.select().from(progress).all()).toHaveLength(0);
    expect(db.select().from(annotations).all()).toHaveLength(0);
    expect(db.select().from(conversations).all()).toHaveLength(0);
    expect(db.select().from(messages).all()).toHaveLength(0);
    // assistant 是共享资源，不随书删
    expect(db.select().from(assistants).all()).toHaveLength(1);
  });

  it("deleteBook removes the book (cascading dependents) and unlinks the owned file", async () => {
    const db = freshDb();
    const booksDir = await mkdtemp(path.join(tmpdir(), "marginalia-del-"));
    try {
      const book = importBook(db, { bytes: makeFixtureEpub() });
      await writeFile(storedEpubPath(booksDir, book.id), new Uint8Array([1]));

      await deleteBook(db, booksDir, book.id);

      expect(listBooks(db)).toHaveLength(0);
      expect(db.select().from(chapters).all()).toHaveLength(0); // 级联
      await expect(readFile(storedEpubPath(booksDir, book.id))).rejects.toMatchObject({
        code: "ENOENT",
      }); // 文件已删
    } finally {
      await rm(booksDir, { recursive: true, force: true });
    }
  });

  it("deleteBook tolerates an already-missing file (best-effort unlink)", async () => {
    const db = freshDb();
    const booksDir = await mkdtemp(path.join(tmpdir(), "marginalia-del-"));
    try {
      const book = importBook(db, { bytes: makeFixtureEpub() }); // 未写文件
      await expect(deleteBook(db, booksDir, book.id)).resolves.toBeUndefined();
      expect(listBooks(db)).toHaveLength(0);
    } finally {
      await rm(booksDir, { recursive: true, force: true });
    }
  });

  it("deleteBook is idempotent — deleting a non-existent book is a no-op (no throw)", async () => {
    const db = freshDb();
    const booksDir = await mkdtemp(path.join(tmpdir(), "marginalia-del-"));
    try {
      await expect(deleteBook(db, booksDir, "urn:uuid:does-not-exist")).resolves.toBeUndefined();
      expect(listBooks(db)).toHaveLength(0);
    } finally {
      await rm(booksDir, { recursive: true, force: true });
    }
  });
});
