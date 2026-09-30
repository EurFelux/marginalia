import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { listChapters, readChapterText } from "@main/library/content";
import { books } from "@main/db/schema";
import { buildSearchIndex } from "@shared/text-search";
import {
  buildEpubCorpus,
  buildPdfCorpus,
  searchBookCorpus,
  searchCorpus,
  AI_SEARCH_MAX_HITS,
  type ChapterCorpus,
} from "@main/ai/search-corpus";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

/** 经 readChapterText 逐页翻完整章并拼接——即「readChapterText 坐标空间」里的章全文。 */
async function readFullChapter(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
): Promise<string> {
  let text = "";
  let offset: number | undefined = 0;
  for (;;) {
    const slice = await readChapterText(db, bytes, bookId, chapterId, { offset, maxChars: 500 });
    text += slice.text;
    if (!slice.hasMore) return text;
    offset = slice.nextOffset;
  }
}

describe("corpus building", () => {
  it("builds epub chapter texts byte-identical to readChapterText's pagination space", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub();
    const book = await importBook(db, { bytes });
    const corpus = await buildEpubCorpus(db, book.id, bytes);
    const chapters = listChapters(db, book.id);
    expect(corpus.map((c) => c.chapterId)).toEqual(chapters.map((c) => c.id));
    for (const chapter of corpus) {
      expect(await readFullChapter(db, bytes, book.id, chapter.chapterId)).toBe(chapter.text);
    }
  });

  it("builds pdf chapter texts byte-identical to readChapterText's pagination space", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: true });
    const book = await importBook(db, { bytes });
    const corpus = await buildPdfCorpus(db, book.id, bytes, book.pageCount);
    for (const chapter of corpus) {
      expect(await readFullChapter(db, bytes, book.id, chapter.chapterId)).toBe(chapter.text);
    }
  });
});

describe("searchBookCorpus (epub)", () => {
  it("returns hits with chapter info and exact chapter offsets", async () => {
    const db = freshDb();
    // 语料缓存按「书 id + parserVersion」键（生产单库成立）；同一字节跨测试会撞键，
    // 故每个经 searchBookCorpus 的测试用独立 title 让书 id 不同。
    const bytes = makeFixtureEpub({ title: "Hit Info Check" });
    const book = await importBook(db, { bytes });
    const { hits, truncated } = await searchBookCorpus(db, book.id, "chapter", async () => bytes);
    expect(truncated).toBe(false);
    expect(hits.map((h) => [h.chapterTitle, h.chapterOffset])).toEqual([
      ["Chapter One", 0],
      ["Chapter Two", 0],
    ]);
    expect(hits[0]!.snippet.match).toBe("Chapter");
  });

  it("gold: readChapterText at chapterOffset lands exactly on the hit", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub({ title: "Offset Gold Check" });
    const book = await importBook(db, { bytes });
    const { hits } = await searchBookCorpus(db, book.id, "hello", async () => bytes);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    // 对齐金测试：偏移直接喂 readChapterText，切片即以命中原文开头（无估计、无窗口补偿）。
    const slice = await readChapterText(db, bytes, book.id, hit.chapterId, {
      offset: hit.chapterOffset,
      maxChars: 20,
    });
    expect(slice.text.startsWith("Hello world.")).toBe(true);
  });
});

describe("searchBookCorpus (pdf)", () => {
  it("attributes hits to exact pages and chapters", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: true });
    const book = await importBook(db, { bytes });
    const { hits } = await searchBookCorpus(db, book.id, "page 2", async () => bytes);
    expect(hits).toHaveLength(4); // fixturePageText 每页重复 4 次
    for (const hit of hits) {
      expect(hit.chapterTitle).toBe("Chapter One"); // Chapter One = p1-2
      expect(hit.page).toBe(2);
    }
    const later = await searchBookCorpus(db, book.id, "page 3", async () => bytes);
    for (const hit of later.hits) {
      expect(hit.chapterTitle).toBe("Chapter Two");
      expect(hit.page).toBe(3);
    }
  });

  it("gold: readChapterText at chapterOffset lands exactly on the hit", async () => {
    const db = freshDb();
    // 与上一测试错开书 id（语料缓存按书 id 键）：用 4 页变体，Chapter Two 仍为 p3 起。
    const bytes = await makeTextPdf({ outline: true, pages: 4 });
    const book = await importBook(db, { bytes });
    const { hits } = await searchBookCorpus(db, book.id, "page 3", async () => bytes);
    const hit = hits[0]!;
    const slice = await readChapterText(db, bytes, book.id, hit.chapterId, {
      offset: hit.chapterOffset,
      maxChars: 20,
    });
    expect(slice.text.startsWith("page 3")).toBe(true);
  });

  it("rejects a scanned pdf with a clear reason instead of empty results", async () => {
    const db = freshDb();
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    await expect(searchBookCorpus(db, book.id, "anything", async () => bytes)).rejects.toThrow(
      /no text layer/,
    );
  });
});

describe("searchCorpus (pure)", () => {
  const synthetic = (texts: string[]): ChapterCorpus[] =>
    texts.map((text, i) => ({
      chapterId: `ch${i}`,
      chapterTitle: `Chapter ${i}`,
      text,
      index: buildSearchIndex({ text }),
    }));

  it("stops at the limit and reports truncation", () => {
    const corpus = synthetic(["hit hit hit", "hit hit hit"]);
    const { hits, truncated } = searchCorpus(corpus, "hit", 5);
    expect(hits).toHaveLength(5);
    expect(truncated).toBe(true);
    const all = searchCorpus(corpus, "hit");
    expect(all.hits).toHaveLength(6);
    expect(all.truncated).toBe(false);
  });

  it("defaults to the AI search hit cap", () => {
    const corpus = synthetic([Array(30).fill("word").join(" ")]);
    const { hits, truncated } = searchCorpus(corpus, "word");
    expect(hits).toHaveLength(AI_SEARCH_MAX_HITS);
    expect(truncated).toBe(true);
  });
});

describe("corpus cache", () => {
  it("loads book bytes once per book and rebuilds on parser version bump", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub({ title: "Corpus Cache Check" });
    const book = await importBook(db, { bytes });
    let loads = 0;
    const loadBytes = async () => {
      loads++;
      return bytes;
    };
    await searchBookCorpus(db, book.id, "hello", loadBytes);
    await searchBookCorpus(db, book.id, "end", loadBytes);
    expect(loads).toBe(1);
    db.update(books).set({ parserVersion: 999 }).where(eq(books.id, book.id)).run();
    await searchBookCorpus(db, book.id, "hello", loadBytes);
    expect(loads).toBe(2);
  });

  it("yields to the event loop while building, so other IPC is not starved", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub({ title: "Corpus Yield Check" });
    const book = await importBook(db, { bytes });
    const order: string[] = [];
    const search = searchBookCorpus(db, book.id, "chapter", async () => bytes).then(() =>
      order.push("search done"),
    );
    setImmediate(() => order.push("other work"));
    await search;
    expect(order).toEqual(["other work", "search done"]);
  });
});
