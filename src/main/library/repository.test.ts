import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
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
import { storedBookPath } from "@main/library/book-files";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("library repository", () => {
  it("imports a book and persists metadata + ordered chapters (pending)", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
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

    // schema 默认值：epub 导入 format='epub'、hasTextLayer=true、pageCount=null
    const row = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(row.format).toBe("epub");
    expect(row.hasTextLayer).toBe(true);
    expect(row.pageCount).toBeNull();
  });

  it("falls back to a content-hash id when the epub has no identifier", async () => {
    const db = freshDb();
    const book = await importBook(db, {
      bytes: makeFixtureEpub({ identifier: null }),
    });
    expect(book.id).toMatch(/^[0-9a-f]{64}$/);
    expect(getBook(db, book.id)).toBeDefined();
  });

  it("idempotent import: re-importing the same epub does not create duplicate books or change chapter ids", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub();

    const book1 = await importBook(db, { bytes });
    const ch1AfterFirst = resolveChapterByHref(db, book1.id, "OEBPS/ch1.xhtml");
    const ch1Id = ch1AfterFirst?.id;

    // Second import of the same bytes
    const book2 = await importBook(db, { bytes });

    expect(listBooks(db)).toHaveLength(1);
    const ch1AfterSecond = resolveChapterByHref(db, book2.id, "OEBPS/ch1.xhtml");
    expect(ch1AfterSecond?.id).toBe(ch1Id);
    // Chapter rows must not double up (fixture has 2 spine items)
    expect(db.select().from(chapters).all()).toHaveLength(2);
  });

  it("resolveChapterByHref returns undefined for a missing href", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    expect(resolveChapterByHref(db, book.id, "OEBPS/nonexistent.xhtml")).toBeUndefined();
  });

  it("ON DELETE CASCADE removes all book-owned dependents", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const assistantId = db.insert(assistants).values({ name: "A" }).returning().get().id;
    db.insert(progress).values({ bookId: book.id, locator: "epubcfi(/6/2)" }).run();
    db.insert(annotations)
      .values({ bookId: book.id, style: "yellow", selectedText: "x", locatorRange: "r" })
      .run();
    const conv = db
      .insert(conversations)
      .values({ bookId: book.id, assistantId })
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
      const book = await importBook(db, { bytes: makeFixtureEpub() });
      await writeFile(storedBookPath(booksDir, book.id, book.format), new Uint8Array([1]));

      await deleteBook(db, booksDir, book.id);

      expect(listBooks(db)).toHaveLength(0);
      expect(db.select().from(chapters).all()).toHaveLength(0); // 级联
      await expect(readFile(storedBookPath(booksDir, book.id, book.format))).rejects.toMatchObject({
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
      const book = await importBook(db, { bytes: makeFixtureEpub() }); // 未写文件
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

  it("listBooks derives hasCover and does not load the cover blob", async () => {
    const db = freshDb();
    await importBook(db, { bytes: makeFixtureEpub() }); // fixture 带封面
    db.insert(books).values({ id: "no-cover", cover: null }).run();

    const items = listBooks(db);
    const withCover = items.find((b) => b.id !== "no-cover")!;
    const noCover = items.find((b) => b.id === "no-cover")!;

    expect(Boolean(withCover.hasCover)).toBe(true);
    expect(Boolean(noCover.hasCover)).toBe(false);
    // 不再把 blob 载进内存（listBooks 不选 cover 列）
    expect(withCover).not.toHaveProperty("cover");
  });

  it("listBooks treats an empty cover blob as hasCover false", () => {
    const db = freshDb();
    db.insert(books)
      .values({ id: "empty-cover", cover: Buffer.alloc(0) })
      .run();
    const item = listBooks(db).find((b) => b.id === "empty-cover")!;
    expect(Boolean(item.hasCover)).toBe(false);
  });
});

describe("importBook (pdf)", () => {
  it("imports a pdf with outline: format/pageCount/chapters with page ranges", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: true, title: "Fixture Book", author: "Tester" });
    const book = await importBook(db, { bytes });
    expect(book.format).toBe("pdf");
    expect(book.title).toBe("Fixture Book");
    expect(book.pageCount).toBe(3);
    expect(book.hasTextLayer).toBe(true);
    expect(book.cover).not.toBeNull(); // 首页缩略图

    const chs = db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .orderBy(asc(chapters.orderIndex))
      .all();
    expect(chs).toHaveLength(2);
    expect(chs[0]).toMatchObject({ href: "pdf-ch:0", startPage: 1, endPage: 2 });
    expect(chs[1]).toMatchObject({ href: "pdf-ch:1", startPage: 3, endPage: 3 });
  });

  it("falls back to single chapter titled by book title when no outline", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: false, title: "Untitled Things" });
    const book = await importBook(db, { bytes });
    const chs = db.select().from(chapters).where(eq(chapters.bookId, book.id)).all();
    expect(chs).toHaveLength(1);
    expect(chs[0]).toMatchObject({
      href: "pdf-ch:0",
      title: "Untitled Things",
      startPage: 1,
      endPage: 3,
    });
  });

  it("detects scanned pdf and stores hasTextLayer=false", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: await makeScannedPdf() });
    expect(book.hasTextLayer).toBe(false);
  });

  it("is idempotent for the same pdf bytes", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: false });
    const a = await importBook(db, { bytes });
    const b = await importBook(db, { bytes });
    expect(b.id).toBe(a.id);
  });

  it("rejects unknown formats with an honest error", async () => {
    const db = freshDb();
    await expect(importBook(db, { bytes: new TextEncoder().encode("hello") })).rejects.toThrow(
      /not a supported book format/i,
    );
  });
});
