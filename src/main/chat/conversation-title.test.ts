// src/main/chat/conversation-title.test.ts
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import {
  createConversation,
  getConversation,
  setConversationTitle,
} from "@main/chat/conversations";
import {
  isNamingConversation,
  nameConversation,
  sanitizeTitle,
  __resetNamingRuntime,
} from "@main/chat/conversation-title";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1" }).run();
  return db;
}

/** doGenerate 直返固定标题的 mock（generateText 走 doGenerate）。 */
function namingModel(title: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      content: [{ type: "text" as const, text: title }],
      warnings: [],
    }),
  });
}

beforeEach(() => __resetNamingRuntime());

describe("sanitizeTitle", () => {
  it("strips quotes/whitespace and truncates to 40 chars with ellipsis", () => {
    expect(sanitizeTitle("「象征意义」")).toBe("象征意义");
    expect(sanitizeTitle(`"  A title  "`)).toBe("A title");
    expect(sanitizeTitle("好".repeat(50))).toBe("好".repeat(40) + "…");
    expect(sanitizeTitle("  \n ")).toBe("");
  });
});

describe("nameConversation", () => {
  it("writes a sanitized title and clears isNaming after settle", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    await nameConversation(
      { db, resolveModel: () => ({ ok: true, model: namingModel("雾的象征"), modelId: "m" }) },
      convo.id,
      "这段雾的描写是什么意思",
      "雾在这里象征……",
    );
    expect(getConversation(db, convo.id)?.title).toBe("雾的象征");
    expect(isNamingConversation(convo.id)).toBe(false);
  });

  it("keeps title null and stays silent when the model is not configured", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    await nameConversation(
      { db, resolveModel: () => ({ ok: false, reason: "no model" }) },
      convo.id,
      "u",
      "a",
    );
    expect(getConversation(db, convo.id)?.title).toBeNull();
  });

  it("does not overwrite an already-set title", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    setConversationTitle(db, convo.id, "手动名");
    await nameConversation(
      { db, resolveModel: () => ({ ok: true, model: namingModel("AI 名"), modelId: "m" }) },
      convo.id,
      "u",
      "a",
    );
    expect(getConversation(db, convo.id)?.title).toBe("手动名");
  });
});
