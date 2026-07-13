import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import type { MessageDto } from "@shared/chat";
import type { MemoryDto } from "@shared/memory";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { memoryLinks, conversations } from "@main/db/schema";
import { setPreference } from "@main/preferences/repository";
import { getMemoryBySlug as getBySlug } from "@main/memory/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import {
  applyMemoryOps,
  renderMemoryPassInput,
  maybeConsolidateMemory,
  __resetConsolidationRuntime,
  CONSOLIDATION_SYSTEM,
  parseMemoryOps,
} from "@main/ai/memory-consolidation";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

describe("CONSOLIDATION_SYSTEM", () => {
  // 自管解析依赖模型吐 JSON——prompt 必须明确要求 JSON 输出，否则 parseMemoryOps 无从下手。
  it("instructs the model to output JSON", () => {
    expect(CONSOLIDATION_SYSTEM.toLowerCase()).toContain("json");
  });
});

describe("parseMemoryOps", () => {
  it("parses a clean JSON object", () => {
    const r = parseMemoryOps('{"ops":[{"op":"delete","slug":"x","reason":"r"}]}');
    expect(r?.ops).toHaveLength(1);
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const r = parseMemoryOps('```json\n{"ops":[]}\n```');
    expect(r?.ops).toEqual([]);
  });

  it("extracts the JSON object even when the model wraps it in prose", () => {
    const r = parseMemoryOps(
      'Sure! Here are the operations:\n{"ops":[{"op":"delete","slug":"y","reason":"merged"}]}\nHope that helps.',
    );
    expect(r?.ops?.[0]?.slug).toBe("y");
  });

  it("returns null on malformed JSON", () => {
    expect(parseMemoryOps("{ops: [}")).toBeNull();
  });

  it("returns null when the shape violates the schema", () => {
    expect(parseMemoryOps('{"ops":[{"op":"frobnicate","slug":"z"}]}')).toBeNull();
  });

  it("returns null when there is no JSON object at all", () => {
    expect(parseMemoryOps("I'm sorry, I can't help with that.")).toBeNull();
  });
});

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("applyMemoryOps", () => {
  it("saves a new memory", () => {
    const db = freshDb();
    const r = applyMemoryOps(db, [
      {
        op: "save",
        slug: "likes-stoicism",
        title: "T",
        description: "D",
        body: "B",
        reason: "x",
      },
    ]);
    expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
    expect(getMemoryBySlug(db, "likes-stoicism")).not.toBeNull();
  });

  it("skips a save whose slug already exists (no overwrite)", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "dup",
      title: "orig",
      description: "d",
      body: "b",
    });
    const r = applyMemoryOps(db, [
      { op: "save", slug: "dup", title: "new", description: "d2", body: "b2", reason: "x" },
    ]);
    expect(r.saved).toBe(0);
    expect(getMemoryBySlug(db, "dup")?.title).toBe("orig");
  });

  it("updates an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "old", description: "d", body: "b" });
    const r = applyMemoryOps(db, [{ op: "update", slug: "m", title: "fresh", reason: "x" }]);
    expect(r.updated).toBe(1);
    expect(getMemoryBySlug(db, "m")?.title).toBe("fresh");
  });

  it("deletes an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "gone", title: "t", description: "d", body: "b" });
    const r = applyMemoryOps(db, [{ op: "delete", slug: "gone", reason: "merged" }]);
    expect(r.deleted).toBe(1);
    expect(getMemoryBySlug(db, "gone")).toBeNull();
  });

  it("skips update/delete on a missing slug without aborting the batch", () => {
    const db = freshDb();
    const r = applyMemoryOps(db, [
      { op: "update", slug: "ghost", title: "x", reason: "x" },
      { op: "save", slug: "real", title: "t", description: "d", body: "b", reason: "x" },
    ]);
    expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
    expect(getMemoryBySlug(db, "real")).not.toBeNull();
  });

  it("syncs [[slug]] links on a saved body", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "target",
      title: "t",
      description: "d",
      body: "b",
    });
    applyMemoryOps(db, [
      {
        op: "save",
        slug: "source",
        title: "t",
        description: "d",
        body: "see [[target]]",
        reason: "x",
      },
    ]);
    const edges = db.select().from(memoryLinks).all();
    expect(edges.length).toBe(1);
  });
});

function turn(seq: number, role: "user" | "assistant", text: string): MessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c",
    role,
    parts: [{ type: "text", text }],
    metadata: null,
    status: "complete",
    seq,
    createdAt: 0,
  };
}

function mem(slug: string, body: string): MemoryDto {
  return {
    id: slug,
    slug,
    title: `T-${slug}`,
    description: `D-${slug}`,
    body,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("renderMemoryPassInput", () => {
  it("includes existing memories and the recent transcript", () => {
    const out = renderMemoryPassInput(
      [turn(1, "user", "hello"), turn(2, "assistant", "hi there")],
      [mem("likes-tea", "drinks tea daily")],
    );
    expect(out).toContain("likes-tea");
    expect(out).toContain("drinks tea daily");
    expect(out).toContain("<user>");
    expect(out).toContain("hello");
    expect(out).toContain("<assistant>");
    expect(out).toContain("hi there");
  });

  it("marks an empty memory store", () => {
    const out = renderMemoryPassInput([turn(1, "user", "x")], []);
    expect(out).toContain("(no existing memories)");
  });

  it("truncates to the char cap keeping the newer tail", () => {
    const long = "z".repeat(1000);
    const out = renderMemoryPassInput([turn(1, "user", long)], [], 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("z");
    expect(out).not.toContain("## Existing memories");
  });
});

const passThrough: RunBackground = (fn) => fn();

/** mock 模型：doGenerate 返回 JSON 文本，generateObject 解析为 { ops }。 */
function opsModel(ops: unknown[]): ResolvedModel {
  return {
    ok: true,
    modelId: "mem",
    model: new MockLanguageModelV4({
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
        content: [{ type: "text" as const, text: JSON.stringify({ ops }) }],
        warnings: [],
      }),
    }),
  };
}

async function seedConvo(assistantTurns: number) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const convo = createConversation(db, { bookId: book.id });
  // 交替 user/assistant，凑够 assistantTurns 条 assistant。
  for (let i = 0; i < assistantTurns * 2; i++) {
    appendMessage(db, {
      conversationId: convo.id,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${i}` }],
    });
  }
  return { db, conversationId: convo.id };
}

function readThrough(db: ReturnType<typeof createDb>, id: string) {
  return db
    .select({ s: conversations.memoryThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get()?.s;
}

describe("maybeConsolidateMemory", () => {
  afterEach(() => __resetConsolidationRuntime());

  it("does nothing when memoryAutoConsolidate is off", async () => {
    const { db, conversationId } = await seedConvo(3);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does nothing below the turn threshold", async () => {
    const { db, conversationId } = await seedConvo(1);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
  });

  it("applies ops, advances the watermark, and notifies on change", async () => {
    const { db, conversationId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      {
        db,
        resolveModel: () =>
          opsModel([
            { op: "save", slug: "new-fact", title: "T", description: "D", body: "B", reason: "x" },
          ]),
        runBackground: passThrough,
        notify,
      },
      conversationId,
      2,
    );
    expect(getBySlug(db, "new-fact")).not.toBeNull();
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalledWith({
      kind: "memoryConsolidated",
      saved: 1,
      updated: 0,
      deleted: 0,
    });
  });

  it("advances the watermark but does not notify when ops are empty", async () => {
    const { db, conversationId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark when the model is unconfigured", async () => {
    const { db, conversationId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      {
        db,
        resolveModel: () => ({ ok: false, reason: "unset" }),
        runBackground: passThrough,
        notify,
      },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark and does not notify when the model call throws", async () => {
    const { db, conversationId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    const throwing: ResolvedModel = {
      ok: true,
      modelId: "boom",
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("boom");
        },
      }),
    };
    await maybeConsolidateMemory(
      { db, resolveModel: () => throwing, runBackground: passThrough, notify },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark and does not notify when the model output is unparseable", async () => {
    const { db, conversationId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    const garbage: ResolvedModel = {
      ok: true,
      modelId: "garbage",
      model: new MockLanguageModelV4({
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
          content: [{ type: "text" as const, text: "I'm sorry, I can't do that." }],
          warnings: [],
        }),
      }),
    };
    await maybeConsolidateMemory(
      { db, resolveModel: () => garbage, runBackground: passThrough, notify },
      conversationId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
