import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { getToc, listChapters, readBookText, readChapterText } from "@main/library/content";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  return { db, bytes, book };
};

describe("content service", () => {
  it("getToc returns the stored, schema-validated toc", () => {
    const { db, book } = setup();
    expect(getToc(db, book.id)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });
  it("readChapterText returns plain text via the parser package", () => {
    const { db, bytes, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = readChapterText(db, bytes, book.id, ch1.id, {});
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("readChapterText throws for an unknown chapterId", () => {
    const { db, bytes, book } = setup();
    expect(() => readChapterText(db, bytes, book.id, "nonexistent-id", {})).toThrow(/not found/);
  });

  it("readChapterText respects offset and maxChars", () => {
    const { db, bytes, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = readChapterText(db, bytes, book.id, ch1.id, { offset: 0, maxChars: 5 });
    expect(r.text.length).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(5);
  });

  it("listChapters is TOC-driven: titled chapters with nesting level", () => {
    const { db, book } = setup();
    const chs = listChapters(db, book.id);
    expect(chs.map((c) => c.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(chs.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(chs.map((c) => c.orderIndex)).toEqual([0, 1]);
    expect(chs.map((c) => c.level)).toEqual([0, 0]);
    expect(chs.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
  });

  it("listChapters excludes spine items absent from the TOC (no title → not a chapter)", () => {
    const { db, book } = setup();
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

  it("readBookText concatenates all chapters in spine order", () => {
    const { db, bytes, book } = setup();
    const r = readBookText(db, bytes, book.id, { maxChars: 100_000 });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("Hello world."); // ch1
    expect(r.text).toContain("The end."); // ch2
    expect(r.text.indexOf("Hello world.")).toBeLessThan(r.text.indexOf("The end.")); // 顺序
  });

  it("readBookText truncates at maxChars and flags truncated", () => {
    const { db, bytes, book } = setup();
    const r = readBookText(db, bytes, book.id, { maxChars: 5 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5);
  });
});
