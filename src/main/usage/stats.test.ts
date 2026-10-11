import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { insertUsage, type UsageEntry } from "@main/usage/ledger";
import { usageStats } from "@main/usage/stats";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const NOW = Temporal.ZonedDateTime.from("2026-10-12T15:00:00[Asia/Shanghai]");
const DAY_MS = 86_400_000;

function entry(over: Partial<UsageEntry>): UsageEntry {
  return {
    createdAt: NOW.epochMilliseconds,
    purpose: "chat",
    model: "m",
    bookId: null,
    requests: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    noCacheTokens: null,
    reasoningTokens: null,
    ...over,
  };
}

describe("usageStats", () => {
  it("labels existing books and folds unknown book ids into deleted", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    insertUsage(db, entry({ bookId: book.id, inputTokens: 300 }));
    insertUsage(db, entry({ bookId: "deleted-book", inputTokens: 40 }));

    const dto = usageStats(db, "30d", NOW);
    expect(dto.byBook).toEqual([
      { kind: "book", bookId: book.id, title: book.title, author: book.author, tokens: 310 },
      { kind: "deleted", count: 1, tokens: 50 },
    ]);
  });

  it("reports existing usage even when the selected range is empty", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(usageStats(db, "7d", NOW).hasAnyUsage).toBe(false);

    insertUsage(db, entry({ createdAt: NOW.epochMilliseconds - 60 * DAY_MS }));
    const week = usageStats(db, "7d", NOW);
    expect(week.hasAnyUsage).toBe(true);
    expect(week.totals.inputTokens).toBe(0);
    expect(usageStats(db, "all", NOW).totals.inputTokens).toBe(100);
  });
});
