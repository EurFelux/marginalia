import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { fixturePageText, makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";
import { openPdf, pageTextFlow } from "@marginalia/pdf-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { searchBook, searchCorpus, type SearchCorpus } from "@main/library/search";
import type { ChapterRefDto } from "@shared/library";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

const chapter = (over: Partial<ChapterRefDto> & { id: string; href: string }): ChapterRefDto => ({
  title: over.id,
  anchor: null,
  orderIndex: 0,
  level: 0,
  startPage: null,
  endPage: null,
  ...over,
});

describe("searchCorpus (epub)", () => {
  // s1：前言 + 锚点章 aA；s2：孤儿文件（无目录项）→ 仍属 aA 那章；s3：新章
  const corpus: SearchCorpus = {
    format: "epub",
    sections: [
      {
        href: "s1.xhtml",
        text: "Preface margin. The margin chapter.",
        breaks: [],
        anchors: { aA: 16 },
      },
      { href: "s2.xhtml", text: "Orphan margin text.", breaks: [], anchors: {} },
      { href: "s3.xhtml", text: "Last margin.", breaks: [], anchors: {} },
    ],
  };
  const chapters = [
    chapter({ id: "pre", href: "s1.xhtml", orderIndex: 0 }),
    chapter({ id: "a", href: "s1.xhtml", anchor: "aA", orderIndex: 1 }),
    chapter({ id: "last", href: "s3.xhtml", orderIndex: 2 }),
  ];

  it("numbers hits per spine file and attributes them to chapters", () => {
    const { hits, truncated } = searchCorpus(corpus, chapters, "margin");
    expect(truncated).toBe(false);
    expect(hits.map((h) => [h.chapterId, h.target])).toEqual([
      ["pre", { format: "epub", href: "s1.xhtml", occurrence: 0 }],
      ["a", { format: "epub", href: "s1.xhtml", occurrence: 1 }],
      ["a", { format: "epub", href: "s2.xhtml", occurrence: 0 }],
      ["last", { format: "epub", href: "s3.xhtml", occurrence: 0 }],
    ]);
  });

  it("builds a snippet around each hit", () => {
    const { hits } = searchCorpus(corpus, chapters, "orphan");
    expect(hits[0]!.snippet).toEqual({ before: "", match: "Orphan", after: " margin text." });
  });

  it("stops at the limit and reports truncation", () => {
    const { hits, truncated } = searchCorpus(corpus, chapters, "margin", 3);
    expect(hits).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("attributes hits before any chapter to no chapter", () => {
    const { hits } = searchCorpus(corpus, [chapter({ id: "last", href: "s3.xhtml" })], "preface");
    expect(hits[0]!.chapterId).toBeNull();
  });
});

describe("searchCorpus (pdf)", () => {
  const corpus: SearchCorpus = {
    format: "pdf",
    pages: [
      { page: 1, text: "alpha beta", breaks: [] },
      { page: 2, text: "gamma", breaks: [] },
      { page: 3, text: "beta again", breaks: [] },
    ],
  };

  it("targets text layer offsets on the page and attributes by start page", () => {
    const chapters = [
      chapter({ id: "one", href: "pdf-ch:0", startPage: 1 }),
      chapter({ id: "two", href: "pdf-ch:1", startPage: 3, orderIndex: 1 }),
    ];
    const { hits } = searchCorpus(corpus, chapters, "beta");
    expect(hits.map((h) => [h.chapterId, h.target])).toEqual([
      ["one", { format: "pdf", page: 1, start: 6, end: 10 }],
      ["two", { format: "pdf", page: 3, start: 0, end: 4 }],
    ]);
  });
});

describe("searchBook", () => {
  it("searches an imported epub", async () => {
    const db = freshDb();
    const bytes = makeFixtureEpub();
    const book = await importBook(db, { bytes });
    const result = await searchBook(db, book.id, "chapter", async () => bytes);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.hits.map((h) => [h.chapterTitle, h.target])).toEqual([
      ["Chapter One", { format: "epub", href: "OEBPS/ch1.xhtml", occurrence: 0 }],
      ["Chapter Two", { format: "epub", href: "OEBPS/ch2.xhtml", occurrence: 0 }],
    ]);
  });

  it("returns pdf hits whose offsets land on the matched words in the text layer flow", async () => {
    const db = freshDb();
    const bytes = await makeTextPdf({ outline: true });
    const book = await importBook(db, { bytes });
    expect(fixturePageText(2)).toContain("page 2");
    const result = await searchBook(db, book.id, "page 2", async () => bytes);
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.hits).toHaveLength(4); // fixturePageText 每页重复 4 次
    const doc = await openPdf(bytes);
    for (const hit of result.hits) {
      if (hit.target.format !== "pdf") throw new Error("expected pdf target");
      expect(hit.target.page).toBe(2);
      const flow = await pageTextFlow(doc, hit.target.page);
      // 第一处命中跨行：行尾在文本层是 <br>、不占字符，故按去空白比较
      expect(flow.text.slice(hit.target.start, hit.target.end).replace(/\s/g, "")).toBe("page2");
    }
    await doc.loadingTask.destroy();
  });

  it("reports a scanned pdf instead of returning nothing", async () => {
    const db = freshDb();
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    expect(await searchBook(db, book.id, "anything", async () => bytes)).toEqual({
      kind: "no-text-layer",
    });
  });
});
