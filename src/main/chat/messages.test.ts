// src/main/chat/messages.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, conversations } from "@main/db/schema";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedConversation(db: ReturnType<typeof freshDb>): string {
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
  const row = db
    .insert(conversations)
    .values({ bookId: "book-1", chapterId: null, assistantId: null })
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

  it("bumps conversations.updatedAt on append", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const before = db
      .select()
      .from(conversations)
      .all()
      .find((c) => c.id === cid)!.updatedAt;
    // 直接改回一个更早的时间，确保 append 会推进它
    db.update(conversations)
      .set({ updatedAt: before - 10_000 })
      .where(eq(conversations.id, cid))
      .run();
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "x" }],
    });
    const after = db
      .select()
      .from(conversations)
      .all()
      .find((c) => c.id === cid)!.updatedAt;
    expect(after).toBeGreaterThan(before - 10_000);
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
});
