// src/main/ai/tools.test.ts
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub, type ChapterTextSlice } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";

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
  it("getToc returns the book's table of contents", async () => {
    const { tools } = setup();
    expect(await tools.getToc.execute!({}, opts)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
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
