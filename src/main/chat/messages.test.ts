// src/main/chat/messages.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { assistants, books, conversations } from "@main/db/schema";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
import { buildChips, dedupeParagraph } from "@main/ai/chips";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedAssistant(db: ReturnType<typeof freshDb>): string {
  return db.insert(assistants).values({ name: "Test" }).returning().get().id;
}

function seedConversation(db: ReturnType<typeof freshDb>): string {
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
  const row = db
    .insert(conversations)
    .values({ bookId: "book-1", chapterId: null, assistantId: seedAssistant(db) })
    .returning()
    .get();
  return row.id;
}

describe("appendMessage / listMessages", () => {
  it("assigns monotonically increasing seq starting at 0", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const m0 = appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const m1 = appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    const all = listMessages(db, cid);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(all.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("persists metadata.contextChips and returns it via listMessages", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "what is this?" }],
      metadata: {
        contextChips: [{ id: "selection", content: "the cat", tokenCount: 2 }],
      },
    });
    const [msg] = listMessages(db, cid);
    expect(msg.metadata?.contextChips?.[0]).toEqual({
      id: "selection",
      content: "the cat",
      tokenCount: 2,
    });
  });

  it("bumps conversations.updatedAt to a fresh timestamp on append", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    db.update(conversations).set({ updatedAt: 1 }).where(eq(conversations.id, cid)).run();
    const t0 = Date.now();
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "x" }],
    });
    const after = db.select().from(conversations).where(eq(conversations.id, cid)).get()!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(t0);
  });

  it("keeps seq independent per conversation", () => {
    const db = freshDb();
    db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
    const assistantId = seedAssistant(db);
    const a = db
      .insert(conversations)
      .values({ bookId: "book-1", chapterId: null, assistantId })
      .returning()
      .get();
    const b = db
      .insert(conversations)
      .values({ bookId: "book-1", chapterId: null, assistantId })
      .returning()
      .get();
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "a0" }],
    });
    appendMessage(db, {
      conversationId: b.id,
      role: "user",
      parts: [{ type: "text", text: "b0" }],
    });
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "a1" }],
    });
    expect(listMessages(db, a.id).map((m) => m.seq)).toEqual([0, 1]);
    expect(listMessages(db, b.id).map((m) => m.seq)).toEqual([0]);
  });

  it("defaults status to 'complete' when not provided", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, { conversationId: cid, role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(listMessages(db, cid)[0].status).toBe("complete");
  });

  it("persists an explicit terminal status and error metadata", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [],
      status: "error",
      metadata: { error: { name: "AI_APICallError", message: "quota exceeded" } },
    });
    const [msg] = listMessages(db, cid);
    expect(msg.status).toBe("error");
    expect(msg.metadata?.error).toEqual({ name: "AI_APICallError", message: "quota exceeded" });
  });
});

describe("getLastParagraphContent", () => {
  it("returns null when no user message carries a paragraph chip", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "no chips" }],
    });
    expect(getLastParagraphContent(db, cid)).toBeNull();
  });

  it("returns the most recently inserted paragraph content, skipping turns without one", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "first" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para A", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
    });
    // 后一轮段落被去重（无 paragraph chip），应回退到 para A
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "second" }],
      metadata: { contextChips: [{ id: "selection", content: "sel", tokenCount: 1 }] },
    });
    expect(getLastParagraphContent(db, cid)).toBe("para A");
  });

  it("returns the higher-seq paragraph when multiple user turns carry one", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "a" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para A", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "b" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para B", tokenCount: 1 }] },
    });
    expect(getLastParagraphContent(db, cid)).toBe("para B");
  });

  it("dedupes a freshly built paragraph against the stored snapshot (format round-trip)", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const input = { selection: "sel", paragraphCurrent: "shared para" };
    const built = buildChips(input);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "q" }],
      // 持久化快照：Chip → {id, content, tokenCount}
      metadata: {
        contextChips: built.map((c) => ({
          id: c.id,
          content: c.content,
          tokenCount: c.tokenCount,
        })),
      },
    });
    const deduped = dedupeParagraph(buildChips(input), getLastParagraphContent(db, cid));
    expect(deduped.map((c) => c.id)).toEqual(["selection"]);
  });
});
