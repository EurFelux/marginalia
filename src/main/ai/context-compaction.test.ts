import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import type { MessageDto } from "@shared/chat";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { conversations } from "@main/db/schema";
import type { ResolvedModel } from "@main/ai/assistant-model";
import {
  __resetCompactionRuntime,
  maybeCompactConversation,
  planFold,
} from "@main/ai/context-compaction";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

/** 构造最小 MessageDto（planFold 只用 seq/role；其余补齐以满足类型）。 */
function msg(seq: number, role: "user" | "assistant"): MessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c",
    role,
    parts: [{ type: "text", text: `t${seq}` }],
    metadata: null,
    status: "complete",
    seq,
    createdAt: 0,
  };
}

/** seq 0,1,2,... 交替 user/assistant，共 n 条。 */
function tail(n: number, startSeq = 0): MessageDto[] {
  return Array.from({ length: n }, (_, i) =>
    msg(startSeq + i, (startSeq + i) % 2 === 0 ? "user" : "assistant"),
  );
}

const each10 = () => 10; // 每条 10 token

describe("planFold", () => {
  it("returns null when the tail estimate is at or below the high-water", () => {
    expect(planFold(tail(4), each10, { high: 100, low: 20, minRecent: 2 })).toBeNull();
  });

  it("folds the oldest exchanges down toward the low-water, on an assistant boundary", () => {
    const plan = planFold(tail(8), each10, { high: 1, low: 25, minRecent: 2 });
    expect(plan).not.toBeNull();
    expect(plan!.foldThroughSeq).toBe(5);
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never folds below the minRecent floor even if the low-water wants more", () => {
    const plan = planFold(tail(8), each10, { high: 1, low: 5, minRecent: 4 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(plan!.foldThroughSeq).toBe(3);
  });

  it("aligns the kept region to a user boundary (keeps one more rather than splitting a pair)", () => {
    const plan = planFold(tail(6), each10, { high: 1, low: 5, minRecent: 3 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1]);
    expect(plan!.foldThroughSeq).toBe(1);
  });

  it("does not crash and folds everything when minRecent is 0 forces an empty kept set", () => {
    // 退化预算 minRecent:0 + 极小 low → keep 累积为 0；此前会越界 tail[tail.length]。
    const plan = planFold(tail(4), each10, { high: 1, low: 1, minRecent: 0 });
    expect(plan).not.toBeNull();
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(plan!.foldThroughSeq).toBe(3);
  });
});

function summaryModel(text: string): ResolvedModel {
  return {
    ok: true,
    modelId: "sum",
    model: new MockLanguageModelV3({
      doGenerate: async () => ({
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
        content: [{ type: "text" as const, text }],
        warnings: [],
      }),
    }),
  };
}

async function seedSixTurns() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const convo = createConversation(db, { bookId: book.id });
  for (let i = 0; i < 6; i++) {
    appendMessage(db, {
      conversationId: convo.id,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${i}` }],
    });
  }
  return { db, conversationId: convo.id };
}

function readConvo(db: ReturnType<typeof createDb>, id: string) {
  return db
    .select({
      summary: conversations.contextSummary,
      through: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
}

const FORCE = { high: 1, low: 1, minRecent: 2 };

describe("maybeCompactConversation", () => {
  afterEach(() => __resetCompactionRuntime());

  it("folds old turns into the summary and advances summarizedThroughSeq", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation(
      { db, resolveModel: () => summaryModel("ROLLED UP") },
      conversationId,
      FORCE,
    );
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBe("ROLLED UP");
    expect(row?.through).toBe(3);
  });

  it("leaves summary and seq untouched when the model is unconfigured", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation(
      { db, resolveModel: () => ({ ok: false, reason: "unset" }) },
      conversationId,
      FORCE,
    );
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });

  it("leaves summary and seq untouched when summarization throws", async () => {
    const { db, conversationId } = await seedSixTurns();
    const throwing: ResolvedModel = {
      ok: true,
      modelId: "sum",
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("summarizer boom");
        },
      }),
    };
    await maybeCompactConversation({ db, resolveModel: () => throwing }, conversationId, FORCE);
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });

  it("is a no-op below the high-water budget", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation({ db, resolveModel: () => summaryModel("X") }, conversationId, {
      high: 1_000_000,
      low: 10,
      minRecent: 2,
    });
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });
});
