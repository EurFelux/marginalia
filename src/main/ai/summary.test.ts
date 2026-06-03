// src/main/ai/summary.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import {
  __resetBookSummaryRuntime,
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  resetStuckSummaries,
  type SummaryDeps,
} from "@main/ai/summary";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// 生成模型 mock：doGenerate 返回固定文本。
// NOTE: LanguageModelV3FinishReason is an object { unified, raw }, not a plain string.
// LanguageModelV3Usage has nested objects for inputTokens/outputTokens.
function genModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function setup(model: ResolvedModel) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SummaryDeps = { db, loadBytes, resolveModel: () => model };
  return { db, book, ch1, deps };
}

function statusOf(db: ReturnType<typeof createDb>, chapterId: string) {
  return db.select().from(chapters).where(eq(chapters.id, chapterId)).get()!;
}

describe("ensureChapterSummary", () => {
  it("generates and stores the summary when the chapter is pending", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: genModel("A concise summary."),
      modelId: "mock",
    });
    await ensureChapterSummary(deps, book.id, ch1.id);
    const row = statusOf(db, ch1.id);
    expect(row.summaryStatus).toBe("ready");
    expect(row.summary).toBe("A concise summary.");
  });

  it("is a no-op when the chapter is not pending (already ready)", async () => {
    const { db, book, ch1, deps } = setup({ ok: true, model: genModel("X"), modelId: "mock" });
    db.update(chapters)
      .set({ summaryStatus: "ready", summary: "cached" })
      .where(eq(chapters.id, ch1.id))
      .run();
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summary).toBe("cached"); // unchanged
  });

  it("marks the chapter unavailable when generation throws", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summaryStatus).toBe("unavailable");
  });

  it("leaves the chapter pending when no model is configured", async () => {
    const { db, book, ch1, deps } = setup({ ok: false, reason: "not configured" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summaryStatus).toBe("pending");
  });
});

describe("resetStuckSummaries", () => {
  it("resets leftover 'generating' chapters back to 'pending'", () => {
    const { db, ch1 } = setup({ ok: false, reason: "x" });
    db.update(chapters).set({ summaryStatus: "generating" }).where(eq(chapters.id, ch1.id)).run();
    resetStuckSummaries(db);
    expect(statusOf(db, ch1.id).summaryStatus).toBe("pending");
  });

  it("leaves ready/unavailable/pending chapters untouched", () => {
    const { db, ch1 } = setup({ ok: false, reason: "x" });
    db.update(chapters)
      .set({ summaryStatus: "ready", summary: "kept" })
      .where(eq(chapters.id, ch1.id))
      .run();
    resetStuckSummaries(db);
    const row = statusOf(db, ch1.id);
    expect(row.summaryStatus).toBe("ready");
    expect(row.summary).toBe("kept");
  });
});

describe("ensureBookSummary / getBookSummaryView (derived status)", () => {
  // book.id 由 fixture 确定、跨用例相同 → 清进程内运行时集保证隔离。
  beforeEach(() => __resetBookSummaryRuntime());

  it("derives pending for a fresh book with no summary", () => {
    const { db, book } = setup({ ok: false, reason: "x" });
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "pending", summary: null });
  });

  it("generates and stores the whole-book summary, deriving ready", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: genModel("Whole-book summary."),
      modelId: "mock",
    });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id)).toEqual({
      status: "ready",
      summary: "Whole-book summary.",
    });
  });

  it("is a no-op when the book summary already exists", async () => {
    const { db, book, deps } = setup({ ok: true, model: genModel("new"), modelId: "mock" });
    db.update(books).set({ summary: "cached" }).where(eq(books.id, book.id)).run();
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).summary).toBe("cached");
  });

  it("derives unavailable (in-memory failed set) when generation throws", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const { db, book, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).status).toBe("unavailable");
  });

  it("stays pending (no write) when no model is configured", async () => {
    const { db, book, deps } = setup({ ok: false, reason: "not configured" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "pending", summary: null });
  });

  it("restart semantics: clearing runtime sets vanishes generating/failed; stored summary still derives ready", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const { db, book, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).status).toBe("unavailable");
    __resetBookSummaryRuntime(); // 模拟重启：进程内集清空
    expect(getBookSummaryView(db, book.id).status).toBe("pending"); // failed 消失 → 可重试
    db.update(books).set({ summary: "S" }).where(eq(books.id, book.id)).run();
    expect(getBookSummaryView(db, book.id).status).toBe("ready"); // summary 在 → ready
  });
});
