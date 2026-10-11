import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateText, streamText } from "ai";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { sql } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import { aiUsage } from "@main/db/schema";
import { meteredModel } from "@main/usage/metered-model";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

const ANTHROPIC_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 100, noCache: 10, cacheRead: 70, cacheWrite: 20 },
  outputTokens: { total: 12, text: 12, reasoning: undefined },
};
const DEEPSEEK_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 50, noCache: 20, cacheRead: 30, cacheWrite: undefined },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

function generateModel(usage: LanguageModelV4Usage) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      content: [{ type: "text" as const, text: "ok" }],
      warnings: [],
    }),
  });
}

function streamModel(usage: LanguageModelV4Usage, chunkDelayInMs?: number) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
        chunks: [
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: "ok" },
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage,
          },
        ],
      }),
    }),
  });
}

describe("meteredModel", () => {
  it("records one ledger row per generate request", async () => {
    const db = freshDb();
    const model = meteredModel(
      { model: generateModel(ANTHROPIC_USAGE), modelId: "claude-sonnet-5-5" },
      { db, purpose: "summary", bookId: "b1" },
    );
    const before = Temporal.Now.instant().epochMilliseconds;
    await generateText({ model, prompt: "hi" });

    const rows = db.select().from(aiUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "summary",
      model: "claude-sonnet-5-5",
      bookId: "b1",
      requests: 1,
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 70,
      cacheWriteTokens: 20,
      noCacheTokens: 10,
      reasoningTokens: null,
    });
    expect(rows[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it("records a streamed request when its finish part arrives, leaving unreported fields null", async () => {
    const db = freshDb();
    const model = meteredModel(
      { model: streamModel(DEEPSEEK_USAGE), modelId: "deepseek-chat" },
      { db, purpose: "chat", bookId: null },
    );
    const result = streamText({ model, prompt: "hi" });
    await result.consumeStream();

    const rows = db.select().from(aiUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "chat",
      bookId: null,
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: null,
      noCacheTokens: 20,
      reasoningTokens: 2,
    });
  });

  it("records nothing when the stream is aborted before its finish part", async () => {
    const db = freshDb();
    const controller = new AbortController();
    const model = meteredModel(
      { model: streamModel(DEEPSEEK_USAGE, 50), modelId: "deepseek-chat" },
      { db, purpose: "chat", bookId: null },
    );
    const result = streamText({ model, prompt: "hi", abortSignal: controller.signal });
    controller.abort();
    await result.consumeStream();

    expect(db.select().from(aiUsage).all()).toEqual([]);
  });

  it("records nothing when the provider reports no totals", async () => {
    const db = freshDb();
    const model = meteredModel(
      {
        model: generateModel({
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        }),
        modelId: "m",
      },
      { db, purpose: "naming", bookId: null },
    );
    await generateText({ model, prompt: "hi" });
    expect(db.select().from(aiUsage).all()).toEqual([]);
  });

  it("keeps the AI call working when writing the ledger fails", async () => {
    const db = freshDb();
    db.run(sql`DROP TABLE ai_usage`);
    const model = meteredModel(
      { model: generateModel(ANTHROPIC_USAGE), modelId: "m" },
      { db, purpose: "memory", bookId: null },
    );
    const { text } = await generateText({ model, prompt: "hi" });
    expect(text).toBe("ok");
  });
});
