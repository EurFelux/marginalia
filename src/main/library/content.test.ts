import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { createDb, runMigrations } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import {
  assertTextLayer,
  getToc,
  listChapters,
  readBookText,
  readChapterText,
} from "@main/library/content";
import { initMainI18n } from "@main/i18n";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";

function anchorBook(): Uint8Array {
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

beforeAll(() => initMainI18n("zh-CN"));

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = async () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = await importBook(db, { bytes });
  return { db, bytes, book };
};

describe("content service", () => {
  it("getToc returns the stored, schema-validated toc", async () => {
    const { db, book } = await setup();
    expect(getToc(db, book.id)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });
  it("readChapterText returns plain text via the parser package", async () => {
    const { db, bytes, book } = await setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = await readChapterText(db, bytes, book.id, ch1.id, {});
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("readChapterText throws for an unknown chapterId", async () => {
    const { db, bytes, book } = await setup();
    await expect(readChapterText(db, bytes, book.id, "nonexistent-id", {})).rejects.toThrow(
      /not found/,
    );
  });

  it("readChapterText respects offset and maxChars", async () => {
    const { db, bytes, book } = await setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = await readChapterText(db, bytes, book.id, ch1.id, { offset: 0, maxChars: 5 });
    expect(r.text.length).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(5);
  });

  it("listChapters is TOC-driven: titled chapters with nesting level", async () => {
    const { db, book } = await setup();
    const chs = listChapters(db, book.id);
    expect(chs.map((c) => c.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(chs.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(chs.map((c) => c.orderIndex)).toEqual([0, 1]);
    expect(chs.map((c) => c.level)).toEqual([0, 0]);
    expect(chs.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
  });

  it("listChapters excludes spine items absent from the TOC (no title → not a chapter)", async () => {
    const { db, book } = await setup();
    // 模拟一个不在 TOC 里的 spine 项（封面 / 分隔页之类）
    db.insert(chapters)
      .values({
        bookId: book.id,
        href: "OEBPS/cover.xhtml",
        orderIndex: 99,
      })
      .run();
    const chs = listChapters(db, book.id);
    expect(chs.map((c) => c.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
  });

  it("readBookText concatenates all chapters in spine order", async () => {
    const { db, bytes, book } = await setup();
    const r = await readBookText(db, bytes, book.id, { maxChars: 100_000 });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("Hello world."); // ch1
    expect(r.text).toContain("The end."); // ch2
    expect(r.text.indexOf("Hello world.")).toBeLessThan(r.text.indexOf("The end.")); // 顺序
  });

  it("readBookText truncates at maxChars and flags truncated", async () => {
    const { db, bytes, book } = await setup();
    const r = await readBookText(db, bytes, book.id, { maxChars: 5 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5);
  });
});

const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("content (pdf)", () => {
  it("readChapterText extracts the chapter's page range with markers", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: true });
    const book = await importBook(db, { bytes });
    const chs = listChapters(db, book.id);
    const slice = await readChapterText(db, bytes, book.id, chs[0]!.id, {});
    expect(slice.text).toContain("[p.1]");
    expect(slice.text).not.toContain("[p.3]"); // 第一章只含 p1–p2
  });

  it("listChapters carries page ranges for pdf", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: await makeTextPdf({ outline: true }) });
    const chs = listChapters(db, book.id);
    expect(chs[0]).toMatchObject({ startPage: 1, endPage: 2 });
  });

  it("readBookText concatenates all pages for pdf", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: false });
    const book = await importBook(db, { bytes });
    const r = await readBookText(db, bytes, book.id, { maxChars: 100_000 });
    expect(r.text).toContain("[p.3]");
    expect(r.truncated).toBe(false);
  });

  it("assertTextLayer throws an honest error for scanned pdf", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: await makeScannedPdf() });
    expect(() => assertTextLayer(db, book.id)).toThrow(/text layer|文本层/i);
  });

  it("assertTextLayer passes for text pdf and epub", async () => {
    const db = freshDb();
    const pdf = await importBook(db, { bytes: await makeTextPdf({ outline: false }) });
    expect(() => assertTextLayer(db, pdf.id)).not.toThrow();
    const epub = await importBook(db, { bytes: makeFixtureEpub() });
    expect(() => assertTextLayer(db, epub.id)).not.toThrow();
  });
});

describe("listChapters with anchors", () => {
  it("returns one entry per TOC anchor (no collapse), with anchor + level", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const list = listChapters(db, book.id);
    expect(list.map((c) => [c.title, c.href, c.anchor, c.level])).toEqual([
      ["第1章", "OEBPS/t0.xhtml", "a1", 0],
      ["第2章", "OEBPS/t0.xhtml", "a2", 0],
      ["第3章", "OEBPS/t1.xhtml", "b1", 0],
    ]);
  });
});

describe("readChapterText with anchors", () => {
  it("reads only the target chapter's text (anchor → next anchor in same file)", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const ch2 = listChapters(db, book.id).find((c) => c.anchor === "a2")!;
    const slice = await readChapterText(db, anchorBook(), book.id, ch2.id, {});
    expect(slice.text).toBe("第2章");
    expect(slice.text).not.toContain("第1章");
  });
});

describe("scanned pdf guard (no text layer)", () => {
  it("readChapterText rejects instead of silently returning empty text", async () => {
    const db = freshDb();
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    const ch = db.select().from(chapters).where(eq(chapters.bookId, book.id)).get()!;
    await expect(readChapterText(db, bytes, book.id, ch.id, {})).rejects.toThrow(
      /text layer|文本层/,
    );
  });

  it("readBookText rejects the same way", async () => {
    const db = freshDb();
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    await expect(readBookText(db, bytes, book.id, { maxChars: 100 })).rejects.toThrow(
      /text layer|文本层/,
    );
  });
});
