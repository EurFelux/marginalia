import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createDb, runMigrations } from "@main/db/client";
import { books, conversations, messages, readingSessions } from "@main/db/schema";
import { createInvestigator } from "@main/reading-report/investigation-runner";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const startedAt = Temporal.Instant.from("2026-07-01T00:00:00Z").epochMilliseconds;
const inside = Temporal.Instant.from("2026-07-05T00:00:00Z").epochMilliseconds;
const completedAt = Temporal.Instant.from("2026-07-10T00:00:00Z").epochMilliseconds;

const USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

describe("createInvestigator", () => {
  it("calls the model without any tools, so submitReport is never offered", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    db.insert(books).values({ id: "book" }).run();
    const session = db
      .insert(readingSessions)
      .values({ bookId: "book", startedAt, completedAt })
      .returning()
      .get();
    db.insert(conversations).values({ id: "conversation", bookId: "book" }).run();
    db.insert(messages)
      .values([
        {
          conversationId: "conversation",
          role: "user",
          parts: [{ type: "text", text: "Is the default option neutral?" }],
          seq: 0,
          createdAt: inside,
        },
        {
          conversationId: "conversation",
          role: "assistant",
          parts: [{ type: "text", text: "Defaults carry a choice architect's intent." }],
          seq: 1,
          createdAt: inside,
        },
      ])
      .run();

    const toolCounts: number[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async ({ tools }) => {
        toolCounts.push(tools?.length ?? 0);
        return {
          content: [{ type: "text", text: JSON.stringify({ topic: "defaults", points: [] }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const investigate = createInvestigator({
      db,
      session,
      resolved: { ok: true, model, modelId: "summary" },
      runBackground: (fn) => fn(),
      abortSignal: new AbortController().signal,
    });
    await investigate({ conversationId: "conversation" });

    expect(toolCounts.length).toBeGreaterThan(0);
    expect(toolCounts.every((count) => count === 0)).toBe(true);
  });
});
