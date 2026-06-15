import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import type { MessageDto } from "@shared/chat";
import type { MemoryDto } from "@shared/memory";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { books, memoryLinks, conversations } from "@main/db/schema";
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
} from "@main/ai/memory-consolidation";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

describe("CONSOLIDATION_SYSTEM", () => {
  // 回归守卫：OpenAI 兼容 provider 在 json_object 响应格式下要求 prompt 含 "json" 字样，
  // 否则整理 pass 每轮必挂（AI_APICallError: "must contain the word 'json'"）。
  it("mentions json (required by OpenAI-compatible json_object response format)", () => {
    expect(CONSOLIDATION_SYSTEM.toLowerCase()).toContain("json");
  });
});

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("applyMemoryOps", () => {
  it("saves a new memory and fills sourceBookId", () => {
    const db = freshDb();
    // Seed a book row so the FK on memories.source_book_id passes.
    db.insert(books).values({ id: "book-1", title: "Test Book", format: "epub" }).run();
    const r = applyMemoryOps(
      db,
      [
        {
          op: "save",
          slug: "likes-stoicism",
          title: "T",
          description: "D",
          body: "B",
          reason: "x",
        },
      ],
      { sourceBookId: "book-1" },
    );
    expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
    const m = getMemoryBySlug(db, "likes-stoicism");
    expect(m?.sourceBookId).toBe("book-1");
  });

  it("skips a save whose slug already exists (no overwrite)", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "dup",
      title: "orig",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const r = applyMemoryOps(
      db,
      [{ op: "save", slug: "dup", title: "new", description: "d2", body: "b2", reason: "x" }],
      { sourceBookId: null },
    );
    expect(r.saved).toBe(0);
    expect(getMemoryBySlug(db, "dup")?.title).toBe("orig");
  });

  it("updates an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "old", description: "d", body: "b", sourceBookId: null });
    const r = applyMemoryOps(db, [{ op: "update", slug: "m", title: "fresh", reason: "x" }], {
      sourceBookId: null,
    });
    expect(r.updated).toBe(1);
    expect(getMemoryBySlug(db, "m")?.title).toBe("fresh");
  });

  it("deletes an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "gone", title: "t", description: "d", body: "b", sourceBookId: null });
    const r = applyMemoryOps(db, [{ op: "delete", slug: "gone", reason: "merged" }], {
      sourceBookId: null,
    });
    expect(r.deleted).toBe(1);
    expect(getMemoryBySlug(db, "gone")).toBeNull();
  });

  it("skips update/delete on a missing slug without aborting the batch", () => {
    const db = freshDb();
    const r = applyMemoryOps(
      db,
      [
        { op: "update", slug: "ghost", title: "x", reason: "x" },
        { op: "save", slug: "real", title: "t", description: "d", body: "b", reason: "x" },
      ],
      { sourceBookId: null },
    );
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
      sourceBookId: null,
    });
    applyMemoryOps(
      db,
      [
        {
          op: "save",
          slug: "source",
          title: "t",
          description: "d",
          body: "see [[target]]",
          reason: "x",
        },
      ],
      { sourceBookId: null },
    );
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
    sourceBookId: null,
    sourceBookTitle: null,
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
    expect(out).toContain("User: hello");
    expect(out).toContain("Assistant: hi there");
  });

  it("marks an empty memory store", () => {
    const out = renderMemoryPassInput([turn(1, "user", "x")], []);
    expect(out).toContain("(no existing memories)");
  });

  it("truncates to the char cap keeping the newer tail", () => {
    const long = "z".repeat(1000);
    const out = renderMemoryPassInput([turn(1, "user", long)], [], 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("z")).toBe(true);
  });
});

const passThrough: RunBackground = (fn) => fn();

/** mock 模型：doGenerate 返回 JSON 文本，generateObject 解析为 { ops }。 */
function opsModel(ops: unknown[]): ResolvedModel {
  return {
    ok: true,
    modelId: "mem",
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
  return { db, conversationId: convo.id, bookId: book.id };
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
    const { db, conversationId, bookId } = await seedConvo(3);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does nothing below the turn threshold", async () => {
    const { db, conversationId, bookId } = await seedConvo(1);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
  });

  it("applies ops, advances the watermark, and notifies on change", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
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
      bookId,
      2,
    );
    expect(getBySlug(db, "new-fact")?.sourceBookId).toBe(bookId);
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalledWith({
      kind: "memoryConsolidated",
      saved: 1,
      updated: 0,
      deleted: 0,
    });
  });

  it("advances the watermark but does not notify when ops are empty", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark when the model is unconfigured", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
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
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark and does not notify when generateObject throws", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    const throwing: ResolvedModel = {
      ok: true,
      modelId: "boom",
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("boom");
        },
      }),
    };
    await maybeConsolidateMemory(
      { db, resolveModel: () => throwing, runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
