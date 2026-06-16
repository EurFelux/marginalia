// src/main/ai/tools.test.ts
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub, type ChapterTextSlice } from "@marginalia/epub-parser";
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";
import { eq } from "drizzle-orm";
import { books } from "@main/db/schema";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { createReadingTools, resolveChapterRef, type LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

async function setup() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = await importBook(db, { bytes });
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
    const { tools } = await setup();
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
    const { tools, ch1 } = await setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: ch1.id },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text).toContain("Hello world.");
    expect(slice.hasMore).toBe(false);
  });

  it("readChapterText accepts an href (as getToc returns) for chapterId", async () => {
    const { tools } = await setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: "OEBPS/ch1.xhtml" },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text).toContain("Hello world.");
  });

  it("readChapterText forwards offset/maxChars for pagination", async () => {
    const { tools, ch1 } = await setup();
    const slice = (await tools.readChapterText.execute!(
      { chapterId: ch1.id, offset: 0, maxChars: 5 },
      opts,
    )) as ChapterTextSlice;
    expect(slice.text.length).toBe(5);
    expect(slice.hasMore).toBe(true);
    expect(slice.nextOffset).toBe(5);
  });

  it("getChapterSummary returns the cached summary state", async () => {
    const { tools, ch1 } = await setup();
    expect(await tools.getChapterSummary.execute!({ chapterId: ch1.id }, opts)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("getBookSummary returns the whole-book summary state (pending when none)", async () => {
    const { tools } = await setup();
    expect(await tools.getBookSummary.execute!({}, opts)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("getBookSummary returns the stored whole-book summary when present", async () => {
    const { db, book, tools } = await setup();
    db.update(books).set({ summary: "the whole-book gist" }).where(eq(books.id, book.id)).run();
    expect(await tools.getBookSummary.execute!({}, opts)).toEqual({
      status: "ready",
      summary: "the whole-book gist",
    });
  });

  it("readChapterText returns an { error } result on an unknown chapterId (no throw — a thrown tool error would abort the whole stream)", async () => {
    const { tools } = await setup();
    const out = (await tools.readChapterText.execute!({ chapterId: "nope" }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/not found/);
    // 自愈数据：错误信息附带真实章节清单，模型可据此换参重试
    expect(out.error).toMatch(/Known chapters include/);
  });

  it("getChapterSummary returns an { error } result on an unknown chapterId", async () => {
    const { tools } = await setup();
    const out = (await tools.getChapterSummary.execute!({ chapterId: "nope" }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/not found/);
  });

  it("readChapterText inputSchema rejects an empty chapterId", async () => {
    const { tools } = await setup();
    const schema = tools.readChapterText.inputSchema as z.ZodType<unknown>;
    expect(schema.safeParse({ chapterId: "" }).success).toBe(false);
  });
});

async function setupPdf(o: { scanned?: boolean; imageToolResults?: boolean } = {}) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = o.scanned
    ? await makeScannedPdf()
    : await makeTextPdf({ outline: true, title: "Px" });
  const book = await importBook(db, { bytes });
  const loadBytes: LoadBytes = async () => bytes;
  const tools = createReadingTools({
    db,
    bookId: book.id,
    loadBytes,
    imageToolResults: o.imageToolResults,
  });
  return { db, book, tools };
}

describe("readPage tool (pdf)", () => {
  it("is absent for epub books", async () => {
    const { tools } = await setup(); // 既有 epub setup
    expect("readPage" in tools).toBe(false);
  });

  it("is present for pdf books", async () => {
    const { tools } = await setupPdf();
    expect("readPage" in tools).toBe(true);
  });

  it("mode text returns the page text with its page marker", async () => {
    const { tools } = await setupPdf();
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 2, mode: "text" }, opts)) as {
      kind: string;
      page: number;
      text: string;
    };
    expect(out.kind).toBe("text");
    expect(out.text).toContain("[p.2]");
    expect(out.text).toContain("body text of page 2");
  });

  it("mode image returns base64 png and toModelOutput emits a file-data content part", async () => {
    const { tools } = await setupPdf({ imageToolResults: true });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 1, mode: "image" }, opts)) as {
      kind: string;
      data: string;
    };
    expect(out.kind).toBe("image");
    const buf = Buffer.from(out.data, "base64");
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数
    const modelOut = await tools.readPage.toModelOutput!({
      toolCallId: "t",
      input: { page: 1, mode: "image" },
      output: out,
    } as never);
    expect(modelOut).toEqual({
      type: "content",
      value: [{ type: "file-data", mediaType: "image/png", data: out.data }],
    });
  });

  it("gates mode image out of the schema when provider lacks image tool results", async () => {
    const { tools } = await setupPdf({ imageToolResults: false });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const schema = tools.readPage.inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({ page: 1, mode: "image" }).success).toBe(false);
    expect(schema.safeParse({ page: 1, mode: "text" }).success).toBe(true);
  });

  it("mode text returns an { error } result for scanned pdfs with an actionable message", async () => {
    const { tools } = await setupPdf({ scanned: true, imageToolResults: true });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 1, mode: "text" }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/scanned|text layer/);
  });

  it("returns an { error } result for out-of-range pages and toModelOutput passes it through as json", async () => {
    const { tools } = await setupPdf();
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 99, mode: "text" }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/out of range/);
    const modelOut = await tools.readPage.toModelOutput!({
      toolCallId: "t",
      input: { page: 99, mode: "text" },
      output: out,
    } as never);
    expect(modelOut).toEqual({ type: "json", value: out });
  });
});

describe("resolveChapterRef", () => {
  it("returns a valid id unchanged and resolves an href to that id", async () => {
    const { db, book, ch1 } = await setup();
    expect(resolveChapterRef(db, book.id, ch1.id)).toBe(ch1.id);
    expect(resolveChapterRef(db, book.id, "OEBPS/ch1.xhtml")).toBe(ch1.id);
  });

  it('resolves a unique chapter title case-insensitively (models pass titles like "Preface")', async () => {
    const { db, book, ch1 } = await setup();
    if (!ch1.title) throw new Error("fixture chapter has no title");
    expect(resolveChapterRef(db, book.id, ch1.title.toUpperCase())).toBe(ch1.id);
    expect(resolveChapterRef(db, book.id, ` ${ch1.title.toLowerCase()} `)).toBe(ch1.id);
  });

  it("throws with the chapter list for a ref that matches nothing", async () => {
    const { db, book } = await setup();
    expect(() => resolveChapterRef(db, book.id, "night_3")).toThrow(/Known chapters include/);
  });
});
