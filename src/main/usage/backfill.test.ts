import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { aiUsage } from "@main/db/schema";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { getAppMeta } from "@main/app-meta/repository";
import { backfillUsageLedger } from "@main/usage/backfill";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

async function seed() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const bookConvo = createConversation(db, { bookId: book.id });
  const libraryConvo = createConversation(db, { bookId: null });
  const say = (conversationId: string, metadata: Parameters<typeof appendMessage>[1]["metadata"]) =>
    appendMessage(db, {
      conversationId,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      metadata,
    });
  appendMessage(db, {
    conversationId: bookConvo.id,
    role: "user",
    parts: [{ type: "text", text: "q" }],
    metadata: { model: "m" },
  });
  // 带拆分的新消息
  const full = say(bookConvo.id, {
    model: "claude-sonnet-5-5",
    usage: {
      inputTokens: 250,
      outputTokens: 30,
      cacheReadTokens: 120,
      cacheWriteTokens: 90,
      noCacheTokens: 40,
      stepCount: 2,
      lastStepInputTokens: 150,
    },
  });
  // 上线前的旧消息：只有总数
  const old = say(libraryConvo.id, {
    model: "deepseek-chat",
    usage: { inputTokens: 80, outputTokens: 8 },
  });
  // 没有用量（中止 / 出错）
  say(bookConvo.id, { model: "m" });
  return { db, book, full, old };
}

describe("backfillUsageLedger", () => {
  it("writes one chat row per assistant message that has usage", async () => {
    const { db, book, full, old } = await seed();
    backfillUsageLedger(db);

    const rows = db.select().from(aiUsage).all();
    expect(rows).toHaveLength(2);
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get("claude-sonnet-5-5")).toMatchObject({
      createdAt: full.createdAt,
      purpose: "chat",
      bookId: book.id,
      requests: 2,
      inputTokens: 250,
      outputTokens: 30,
      cacheReadTokens: 120,
      cacheWriteTokens: 90,
      noCacheTokens: 40,
      reasoningTokens: null,
    });
    expect(byModel.get("deepseek-chat")).toMatchObject({
      createdAt: old.createdAt,
      bookId: null,
      requests: 1,
      inputTokens: 80,
      outputTokens: 8,
      cacheReadTokens: null,
    });
    expect(getAppMeta(db, "usageLedgerBackfilled")).toBe(true);
  });

  it("runs only once", async () => {
    const { db } = await seed();
    backfillUsageLedger(db);
    backfillUsageLedger(db);
    expect(db.select().from(aiUsage).all()).toHaveLength(2);
  });
});
