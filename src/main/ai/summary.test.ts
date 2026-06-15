// src/main/ai/summary.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import type { RunBackground } from "@main/ai/background-limiter";
import { Limiter } from "@main/ai/background-limiter";
import {
  __resetBookSummaryRuntime,
  __resetChapterSummaryRuntime,
  assertSummaryModelReady,
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  getChapterSummaryView,
  type SummaryDeps,
} from "@main/ai/summary";

/** 透传 runBackground：直接执行 fn()，不限流；现有测试用此保持行为不变。 */
const passThrough: RunBackground = (fn) => fn();

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

const STREAM_USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

// 流式模型 mock（ensureBookSummary 用 streamText）：发一段 text-delta 后正常结束。
function streamModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: STREAM_USAGE,
          },
        ],
      }),
    }),
  });
}

async function setup(model: ResolvedModel) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = await importBook(db, { bytes });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SummaryDeps = {
    db,
    loadBytes,
    resolveModel: () => model,
    runBackground: passThrough,
  };
  return { db, book, ch1, deps };
}

describe("ensureChapterSummary / getChapterSummaryView (derived status)", () => {
  // chapter.id 由 fixture 确定、跨用例相同 → 清进程内运行时集保证隔离。
  beforeEach(() => __resetChapterSummaryRuntime());

  it("derives pending for a fresh chapter with no summary", async () => {
    const { db, book, ch1, deps: _deps } = await setup({ ok: false, reason: "x" });
    void _deps;
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("throws for an unknown chapterId", async () => {
    const { db, book } = await setup({ ok: false, reason: "x" });
    expect(() => getChapterSummaryView(db, book.id, "nonexistent-id")).toThrow(/not found/);
  });

  it("generates and stores the summary, deriving ready", async () => {
    const { db, book, ch1, deps } = await setup({
      ok: true,
      model: genModel("A concise summary."),
      modelId: "mock",
    });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "ready",
      summary: "A concise summary.",
    });
  });

  it("is a no-op when the summary already exists", async () => {
    const { db, book, ch1, deps } = await setup({
      ok: true,
      model: genModel("new"),
      modelId: "mock",
    });
    db.update(chapters).set({ summary: "cached" }).where(eq(chapters.id, ch1.id)).run();
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).summary).toBe("cached"); // unchanged
  });

  it("derives unavailable when generation throws", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const { db, book, ch1, deps } = await setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("unavailable");
  });

  it("stays pending when no model is configured", async () => {
    const { db, book, ch1, deps } = await setup({ ok: false, reason: "not configured" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("pending");
  });

  it("restart semantics: clearing runtime vanishes generating/failed; stored summary still derives ready", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const { db, book, ch1, deps } = await setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("unavailable");
    __resetChapterSummaryRuntime(); // 模拟重启：进程内集清空
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("pending"); // failed 消失 → 可重试
    db.update(chapters).set({ summary: "S" }).where(eq(chapters.id, ch1.id)).run();
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("ready"); // summary 在 → ready
  });

  it("does not store an empty generation; derives unavailable (retryable)", async () => {
    const { db, book, ch1, deps } = await setup({ ok: true, model: genModel(""), modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    const row = db
      .select({ summary: chapters.summary })
      .from(chapters)
      .where(eq(chapters.id, ch1.id))
      .get();
    expect(row?.summary).toBeNull(); // 空产出不落库
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("unavailable");
  });

  it("treats whitespace-only generation as empty (not stored)", async () => {
    const { db, book, ch1, deps } = await setup({
      ok: true,
      model: genModel("  \n\t "),
      modelId: "mock",
    });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "unavailable",
      summary: null,
    });
  });

  it("derives pending for a stored empty summary (self-heals legacy bad rows on read)", async () => {
    const { db, book, ch1 } = await setup({ ok: false, reason: "x" });
    db.update(chapters).set({ summary: "" }).where(eq(chapters.id, ch1.id)).run();
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("regenerates over a stored empty summary instead of skipping", async () => {
    const { db, book, ch1, deps } = await setup({
      ok: true,
      model: genModel("fresh"),
      modelId: "mock",
    });
    db.update(chapters).set({ summary: "" }).where(eq(chapters.id, ch1.id)).run();
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "ready",
      summary: "fresh",
    });
  });

  it("force=true regenerates over an existing summary", async () => {
    const { db, book, ch1, deps } = await setup({
      ok: true,
      model: genModel("fresh"),
      modelId: "mock",
    });
    db.update(chapters).set({ summary: "cached" }).where(eq(chapters.id, ch1.id)).run();
    await ensureChapterSummary(deps, book.id, ch1.id, true);
    expect(getChapterSummaryView(db, book.id, ch1.id).summary).toBe("fresh");
  });
});

describe("ensureBookSummary / getBookSummaryView (derived status)", () => {
  // book.id 由 fixture 确定、跨用例相同 → 清进程内运行时集保证隔离。
  beforeEach(() => __resetBookSummaryRuntime());

  it("derives pending for a fresh book with no summary", async () => {
    const { db, book } = await setup({ ok: false, reason: "x" });
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "pending", summary: null });
  });

  it("streams and stores the whole-book summary, deriving ready", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: streamModel("Whole-book summary."),
      modelId: "mock",
    });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id)).toEqual({
      status: "ready",
      summary: "Whole-book summary.",
    });
  });

  it("is a no-op when the book summary already exists (force=false)", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: streamModel("new"),
      modelId: "mock",
    });
    db.update(books).set({ summary: "cached" }).where(eq(books.id, book.id)).run();
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).summary).toBe("cached");
  });

  it("force=true regenerates over an existing summary", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: streamModel("fresh"),
      modelId: "mock",
    });
    db.update(books).set({ summary: "old" }).where(eq(books.id, book.id)).run();
    await ensureBookSummary(deps, book.id, true);
    expect(getBookSummaryView(db, book.id).summary).toBe("fresh");
  });

  it("derives unavailable when streaming errors (keeps old summary unwritten)", async () => {
    const failModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("stream boom");
      },
    });
    const { db, book, deps } = await setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).status).toBe("unavailable");
  });

  it("stays pending (no write) when no model is configured", async () => {
    const { db, book, deps } = await setup({ ok: false, reason: "not configured" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "pending", summary: null });
  });

  it("restart semantics: clearing runtime sets vanishes generating/failed; stored summary still derives ready", async () => {
    const failModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("boom");
      },
    });
    const { db, book, deps } = await setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id).status).toBe("unavailable");
    __resetBookSummaryRuntime(); // 模拟重启：进程内集清空
    expect(getBookSummaryView(db, book.id).status).toBe("pending"); // failed 消失 → 可重试
    db.update(books).set({ summary: "S" }).where(eq(books.id, book.id)).run();
    expect(getBookSummaryView(db, book.id).status).toBe("ready"); // summary 在 → ready
  });

  it("does not store an empty stream output (forced regen keeps old summary, derives ready)", async () => {
    const { db, book, deps } = await setup({ ok: true, model: streamModel(""), modelId: "mock" });
    db.update(books).set({ summary: "old" }).where(eq(books.id, book.id)).run();
    await ensureBookSummary(deps, book.id, true);
    // 空产出不覆盖旧摘要；旧摘要仍有效 → 派生 ready（与 stream error 保留旧摘要的语义一致）
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "ready", summary: "old" });
  });

  it("does not store an empty stream output; derives unavailable when no old summary exists", async () => {
    const { db, book, deps } = await setup({ ok: true, model: streamModel(""), modelId: "mock" });
    await ensureBookSummary(deps, book.id);
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "unavailable", summary: null });
  });

  it("derives pending for a stored empty book summary (self-heals legacy bad rows on read)", async () => {
    const { db, book } = await setup({ ok: false, reason: "x" });
    db.update(books).set({ summary: "" }).where(eq(books.id, book.id)).run();
    expect(getBookSummaryView(db, book.id)).toEqual({ status: "pending", summary: null });
  });
});

describe("background concurrency cap (Limiter integration)", () => {
  beforeEach(() => {
    __resetChapterSummaryRuntime();
    __resetBookSummaryRuntime();
  });

  it("with cap=1, the second background model call does not start until the first finishes", async () => {
    // 用同一 Limiter(()=>1) 注入 ensureChapterSummary + ensureBookSummary：
    // 两个都走 runBackground 路径，上限 1 时第二个必须等第一个完成才能进槽。
    let firstCallStarted = false;
    let secondCallStarted = false;

    // 第一个 model call（章节，generateText）：阻塞在 gate 上，等外部 resolve 才完成。
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });

    const blockedGenModel = new MockLanguageModelV3({
      doGenerate: async () => {
        firstCallStarted = true;
        await gate; // 阻塞直到外部 releaseGate()
        return {
          content: [{ type: "text" as const, text: "chapter summary" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const blockedStreamModel = new MockLanguageModelV3({
      doStream: async () => {
        secondCallStarted = true;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "book summary" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: STREAM_USAGE,
              },
            ],
          }),
        };
      },
    });

    const sharedLimiter = new Limiter(() => 1);

    // 从同一个 setup 拿到 db/book/ch1/loadBytes（同一内存库，book 和 chapter 都在）
    const {
      db,
      book,
      ch1,
      deps: baseDeps,
    } = await setup({
      ok: true,
      model: blockedGenModel,
      modelId: "mock",
    });

    const chapterDeps: SummaryDeps = {
      ...baseDeps,
      resolveModel: () => ({ ok: true, model: blockedGenModel, modelId: "mock" }),
      runBackground: sharedLimiter.run,
    };
    const bookDeps: SummaryDeps = {
      ...baseDeps,
      resolveModel: () => ({ ok: true, model: blockedStreamModel, modelId: "mock" }),
      runBackground: sharedLimiter.run,
    };

    // 同时发起两个后台任务（不 await）——两者共享同一 db，book/ch1 均存在
    const p1 = ensureChapterSummary(chapterDeps, book.id, ch1.id);
    const p2 = ensureBookSummary(bookDeps, book.id);

    // 让 microtask queue 跑一下，让两个 ensure* 的同步前缀和第一个 runBackground 进槽
    await new Promise<void>((r) => setTimeout(r, 0));

    // 此时：第一个（章节）应已进槽、firstCallStarted=true；第二个（全书）在队列中、secondCallStarted=false
    expect(firstCallStarted).toBe(true);
    expect(secondCallStarted).toBe(false);

    // 释放门控：第一个完成 → limiter 放行第二个
    releaseGate();
    await p1;
    await p2;

    // 两个都应跑完，结果落库
    expect(secondCallStarted).toBe(true);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("ready");
    expect(getBookSummaryView(db, book.id).status).toBe("ready");
  });
});

describe("assertSummaryModelReady", () => {
  it("throws the resolver's reason when no model is configured", () => {
    // 手动生成入口的预检（镜像聊天的发送前拦截）：模型未配置不再静默保持 pending——
    // handler 据此 reject，渲染层 toast 透传真实原因（如「Provider 未设置密钥」）。
    expect(() => assertSummaryModelReady(() => ({ ok: false, reason: "no key" }))).toThrow(
      "no key",
    );
  });

  it("is a no-op when the model resolves", async () => {
    const { deps } = await setup({ ok: true, model: genModel("s"), modelId: "mock" });
    expect(() => assertSummaryModelReady(deps.resolveModel)).not.toThrow();
  });
});
