// src/main/ai/tools.test.ts
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub, type ChapterTextSlice } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { createReadingTools, resolveChapterRef, type LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function setup() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const loadBytes: LoadBytes = async () => bytes;
  const tools = createReadingTools({ db, bookId: book.id, loadBytes });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  return { db, bytes, book, tools, ch1 };
}

// tool.execute 第二参数 (ToolExecutionOptions) 测试只需最小 stub；
// AI SDK 把 execute 返回类型建模为宽联合（值 | Promise | AsyncIterable），故访问结果属性处需 as 收窄。
const opts = { toolCallId: "test", messages: [] } as never;

describe("createReadingTools", () => {
  it("getToc returns chapters with ids and titles the read tools accept", async () => {
    const { tools } = setup();
    const toc = (await tools.getToc.execute!({}, opts)) as Array<{
      id: string;
      title: string | null;
      href: string;
    }>;
    expect(toc.map((c) => c.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(toc.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(toc.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
  });

  it("readChapterText loads bytes via the port and returns verbatim text", async () => {
    const { tools, ch1 } = setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: ch1.id },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text).toContain("Hello world.");
    expect(slice.hasMore).toBe(false);
  });

  it("readChapterText accepts an href (as getToc returns) for chapterId", async () => {
    const { tools } = setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: "OEBPS/ch1.xhtml" },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text).toContain("Hello world.");
  });

  it("readChapterText forwards offset/maxChars for pagination", async () => {
    const { tools, ch1 } = setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: ch1.id, offset: 0, maxChars: 5 },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text.length).toBe(5);
    expect(slice.hasMore).toBe(true);
    expect(slice.nextOffset).toBe(5);
  });

  it("getChapterSummary returns the cached summary state", async () => {
    const { tools, ch1 } = setup();
    expect(await tools.getChapterSummary.execute!({ chapterId: ch1.id }, opts)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("readChapterText rejects on an unknown chapterId (error propagates to the agent loop)", async () => {
    const { tools } = setup();
    await expect(tools.readChapterText.execute!({ chapterId: "nope" }, opts)).rejects.toThrow(
      "not found",
    );
  });

  it("getChapterSummary rejects on an unknown chapterId", async () => {
    const { tools } = setup();
    await expect(tools.getChapterSummary.execute!({ chapterId: "nope" }, opts)).rejects.toThrow(
      "not found",
    );
  });

  it("readChapterText inputSchema rejects an empty chapterId", () => {
    const { tools } = setup();
    const schema = tools.readChapterText.inputSchema as z.ZodType<unknown>;
    expect(schema.safeParse({ chapterId: "" }).success).toBe(false);
  });
});

describe("resolveChapterRef", () => {
  it("returns a valid id unchanged and resolves an href to that id", () => {
    const { db, book, ch1 } = setup();
    expect(resolveChapterRef(db, book.id, ch1.id)).toBe(ch1.id);
    expect(resolveChapterRef(db, book.id, "OEBPS/ch1.xhtml")).toBe(ch1.id);
  });

  it("throws for a ref that is neither a known id nor href", () => {
    const { db, book } = setup();
    expect(() => resolveChapterRef(db, book.id, "night_3")).toThrow(/not found/);
  });
});
