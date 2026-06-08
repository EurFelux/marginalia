import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
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
  listRecentlyRead,
  reorderBooks,
  resolveChapterByHref,
  resolveChapter,
  reindexBookIfStale,
  updateBook,
  CURRENT_PARSER_VERSION,
} from "@main/library/repository";
import { saveProgress } from "@main/library/progress";
import { storedBookPath } from "@main/library/book-files";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { renderPageImage } from "@marginalia/pdf-parser";
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";

// 部分替换：renderPageImage 包成 vi.fn（默认透传真实实现），供封面 fail-open 用例单次注入失败。
vi.mock("@marginalia/pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marginalia/pdf-parser")>();
  return { ...actual, renderPageImage: vi.fn(actual.renderPageImage) };
});

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
    expect(book.id).toMatch(/^[0-9a-f]{64}$/); // 身份＝内容哈希（不再用 dc:identifier）
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

  it("imports two different books that share the same epub dc:identifier (boilerplate uid collision)", async () => {
    const db = freshDb();
    // 现实坑：z-library 等转换源会给不同的书盖同一个写死的 dc:identifier。
    // 身份必须由内容决定，否则第二本会被误判「已存在」而丢失。
    const sharedUid = "urn:uuid:273fd756-collision";
    const a = await importBook(db, {
      bytes: makeFixtureEpub({ identifier: sharedUid, title: "Book A" }),
    });
    const b = await importBook(db, {
      bytes: makeFixtureEpub({ identifier: sharedUid, title: "Book B" }),
    });

    expect(listBooks(db)).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe("Book A");
    expect(b.title).toBe("Book B");
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

  it("succeeds with cover=null when cover render fails (fail-open)", async () => {
    const db = freshDb();
    vi.mocked(renderPageImage).mockRejectedValueOnce(new Error("render failed"));
    const book = await importBook(db, {
      bytes: await makeTextPdf({ outline: false, title: "Cover Fail" }),
    });
    expect(book.cover).toBeNull();
    expect(listBooks(db)).toHaveLength(1); // 导入不被封面失败阻塞
  });

  it("falls back to the file name (sans extension) when pdf metadata has no title", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: false }); // 不带 title 选项 → 元数据无 Title
    const book = await importBook(db, { bytes, fileName: "深入浅出统计学.pdf" });
    expect(book.title).toBe("深入浅出统计学");
    // 单章退化的章节 title 兜底也应用同一回退值
    const chs = db.select().from(chapters).where(eq(chapters.bookId, book.id)).all();
    expect(chs[0]!.title).toBe("深入浅出统计学");
  });

  it("metadata title wins over the file name", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: false, title: "Real Title" });
    const book = await importBook(db, { bytes, fileName: "whatever.pdf" });
    expect(book.title).toBe("Real Title");
  });
});

describe("updateBook", () => {
  it("updates title and author and persists", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const updated = updateBook(db, {
      bookId: book.id,
      title: "Clean Title",
      author: "Real Author",
    });
    expect(updated.title).toBe("Clean Title");
    expect(updated.author).toBe("Real Author");
    const row = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(row.title).toBe("Clean Title");
    expect(row.author).toBe("Real Author");
  });

  it("clears author with null", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    updateBook(db, { bookId: book.id, title: "T", author: null });
    const row = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(row.author).toBeNull();
  });

  it("throws for unknown book id", () => {
    const db = freshDb();
    expect(() => updateBook(db, { bookId: "nope", title: "X", author: null })).toThrow(/not found/);
  });

  it("does not touch other columns", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const before = db.select().from(books).where(eq(books.id, book.id)).get()!;
    updateBook(db, { bookId: book.id, title: "New", author: null });
    const after = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(after.cover).toEqual(before.cover);
    expect(after.toc).toEqual(before.toc);
    expect(after.format).toBe(before.format);
    expect(after.summary).toBe(before.summary);
  });
});

// 裸插书行（绕过 importBook 的 fixture 同 bytes→同 id 幂等限制；只测排序/查询无需完整导入）。
let _seedSeq = 0;
const seedBook = (db: ReturnType<typeof createDb>, id: string, position = 0) => {
  db.insert(books).values({ id, title: id, position, addedAt: ++_seedSeq }).run();
};

describe("listBooks ordering (#48)", () => {
  it("orders by position, then added_at for ties", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    seedBook(db, "a"); // position 全 0 → added_at（插入序）平断
    seedBook(db, "b");
    seedBook(db, "c", -1); // 模拟新导入排最前
    expect(listBooks(db).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });
});

describe("listRecentlyRead (#48)", () => {
  const setupRead = () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    for (const id of ["a", "b", "c", "d"]) seedBook(db, id);
    return db;
  };
  const touch = (db: ReturnType<typeof createDb>, id: string, at: number, percent?: number) => {
    saveProgress(db, id, "epubcfi(/6/2!/4/1:0)", percent);
    db.update(progress).set({ updatedAt: at }).where(eq(progress.bookId, id)).run();
  };

  it("returns only read books, most recent first", () => {
    const db = setupRead();
    touch(db, "a", 1000);
    touch(db, "b", 3000);
    expect(listRecentlyRead(db).map((r) => r.id)).toEqual(["b", "a"]); // d/c 未读不出现
  });

  it("caps at limit 3 and carries percent + lastReadAt", () => {
    const db = setupRead();
    touch(db, "a", 1000, 0.1);
    touch(db, "b", 2000); // percent 未传 → null
    touch(db, "c", 3000, 0.5);
    touch(db, "d", 4000, 0.9);
    const r = listRecentlyRead(db);
    expect(r.map((x) => x.id)).toEqual(["d", "c", "b"]);
    expect(r[0]).toMatchObject({ percent: 0.9, lastReadAt: 4000 });
    expect(r[2]!.percent).toBeNull();
  });
});

function anchorBook(): Uint8Array {
  const { strToU8, zipSync } = require("fflate") as typeof import("fflate");
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:anchor-book</dc:identifier><dc:title>Anchor Book</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="t0" href="t0.xhtml" media-type="application/xhtml+xml"/>
    <item id="t1" href="t1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="t0"/><itemref idref="t1"/></spine>
</package>`),
    "OEBPS/toc.ncx": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>第1章</text></navLabel><content src="t0.xhtml#a1"/></navPoint>
  <navPoint id="n2"><navLabel><text>第2章</text></navLabel><content src="t0.xhtml#a2"/></navPoint>
  <navPoint id="n3"><navLabel><text>第3章</text></navLabel><content src="t1.xhtml#b1"/></navPoint>
</navMap></ncx>`),
    "OEBPS/t0.xhtml": strToU8(
      `<html><body><p><span id="a1">第1章</span></p><p><span id="a2">第2章</span></p></body></html>`,
    ),
    "OEBPS/t1.xhtml": strToU8(`<html><body><p><span id="b1">第3章</span></p></body></html>`),
  });
}

describe("importEpubBook builds chapters from TOC entries (anchors)", () => {
  it("creates one chapter row per TOC entry with anchor", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const rows = db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .orderBy(asc(chapters.orderIndex))
      .all();
    expect(rows.map((r) => [r.title, r.href, r.anchor])).toEqual([
      ["第1章", "OEBPS/t0.xhtml", "a1"],
      ["第2章", "OEBPS/t0.xhtml", "a2"],
      ["第3章", "OEBPS/t1.xhtml", "b1"],
    ]);
    expect(book.parserVersion).toBe(CURRENT_PARSER_VERSION);
  });

  it("resolveChapter matches exact (href, anchor)", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const ch = resolveChapter(db, book.id, "OEBPS/t0.xhtml", "a2");
    expect(ch?.title).toBe("第2章");
  });
});

describe("reindexBookIfStale", () => {
  it("rebuilds chapters + toc + parserVersion when stale; no-op when fresh", async () => {
    const db = freshDb();
    const bytes = anchorBook();
    const book = await importBook(db, { bytes });
    // 模拟存量旧书：降级 parserVersion 并把 chapters 砍成 1 行（旧 spine 口径）。
    db.update(books).set({ parserVersion: 0 }).where(eq(books.id, book.id)).run();
    db.delete(chapters).where(eq(chapters.bookId, book.id)).run();
    db.insert(chapters)
      .values({ bookId: book.id, href: "OEBPS/t0.xhtml", orderIndex: 0, title: null })
      .run();

    const changed = reindexBookIfStale(db, bytes, book.id);
    expect(changed).toBe(true);
    const rows = db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .orderBy(asc(chapters.orderIndex))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.anchor)).toEqual(["a1", "a2", "b1"]);
    expect(db.select().from(books).where(eq(books.id, book.id)).get()?.parserVersion).toBe(
      CURRENT_PARSER_VERSION,
    );

    // 第二次调用：版本已最新 ⇒ no-op。
    expect(reindexBookIfStale(db, bytes, book.id)).toBe(false);
  });

  it("PDF books are skipped (no epub reparse)", async () => {
    // PDF 书 reindexBookIfStale 返回 false 不抛。
    const db = freshDb();
    // 裸插一个 format=pdf 的书行（绕过 importPdfBook 依赖）。
    db.insert(books).values({ id: "pdf-fake", format: "pdf", parserVersion: 0 }).run();
    const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF- 魔数
    expect(reindexBookIfStale(db, fakeBytes, "pdf-fake")).toBe(false);
  });
});

describe("reorderBooks (#48)", () => {
  it("rewrites positions so listBooks follows the given order", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    for (const id of ["a", "b", "c"]) seedBook(db, id);
    reorderBooks(db, ["c", "a", "b"]);
    expect(listBooks(db).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });
});

describe("import position (#48)", () => {
  it("new imports land before existing books (MIN - 1; 0 on empty library)", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const epub = await importBook(db, { bytes: makeFixtureEpub() }); // 空库 → 0
    const pdf = await importBook(db, { bytes: await makeTextPdf({ outline: false }) }); // → -1，排最前
    expect(listBooks(db).map((b) => b.id)).toEqual([pdf.id, epub.id]);
  });
});
