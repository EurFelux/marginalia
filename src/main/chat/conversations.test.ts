// src/main/chat/conversations.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters, conversations, messages } from "@main/db/schema";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationsByBook,
  setConversationTitle,
} from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedBookWithChapters(db: ReturnType<typeof freshDb>) {
  db.insert(books).values({ id: "book-1" }).run();
  const ch1 = db
    .insert(chapters)
    .values({ bookId: "book-1", href: "c1.html", orderIndex: 0, title: "Ch 1" })
    .returning()
    .get();
  const ch2 = db
    .insert(chapters)
    .values({ bookId: "book-1", href: "c2.html", orderIndex: 1, title: "Ch 2" })
    .returning()
    .get();
  return { ch1: ch1.id, ch2: ch2.id };
}

describe("createConversation / getConversation / listConversationsByBook", () => {
  it("creates a conversation bound to a book", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const convo = createConversation(db, { bookId: "book-1" });
    expect(convo.bookId).toBe("book-1");
    expect(convo.isNaming).toBe(false);
    expect(getConversation(db, convo.id)?.id).toBe(convo.id);
  });

  it("getConversation returns null for an unknown id", () => {
    const db = freshDb();
    expect(getConversation(db, "nope")).toBeNull();
  });

  it("lists conversations for a book most-recently-updated first", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const a = createConversation(db, { bookId: "book-1" });
    // a has a message →防堆积允许创建 b
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const b = createConversation(db, { bookId: "book-1" });
    // 显式设定不同 updatedAt，避免同毫秒打平导致排序不确定
    db.update(conversations).set({ updatedAt: 1 }).where(eq(conversations.id, a.id)).run();
    db.update(conversations).set({ updatedAt: 2 }).where(eq(conversations.id, b.id)).run();
    const list = listConversationsByBook(db, "book-1");
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });
});

describe("createConversation reuses empty conversation", () => {
  it("returns the existing zero-message conversation instead of stacking new ones", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const first = createConversation(db, { bookId: "book-1" });
    const second = createConversation(db, { bookId: "book-1" });
    expect(second.id).toBe(first.id);
  });

  it("creates a fresh conversation when the existing one has messages", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const first = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: first.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const second = createConversation(db, { bookId: "book-1" });
    expect(second.id).not.toBe(first.id);
  });

  it("does not reuse an empty conversation from another book", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    db.insert(books).values({ id: "book-2" }).run();
    const otherBookEmpty = createConversation(db, { bookId: "book-2" });
    const created = createConversation(db, { bookId: "book-1" });
    expect(created.id).not.toBe(otherBookEmpty.id);
    expect(created.bookId).toBe("book-1");
  });
});

describe("setConversationTitle", () => {
  it("updates the title and is read back by getConversation", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const conv = createConversation(db, { bookId: "book-1" });
    setConversationTitle(db, conv.id, "关于灯塔的光");
    expect(getConversation(db, conv.id)?.title).toBe("关于灯塔的光");
  });
});

describe("deleteConversation", () => {
  it("removes the conversation and cascades its messages", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const convo = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    deleteConversation(db, convo.id);
    expect(getConversation(db, convo.id)).toBeNull();
    const remaining = db.select().from(messages).where(eq(messages.conversationId, convo.id)).all();
    expect(remaining).toEqual([]);
  });

  it("is idempotent: deleting an unknown id does not throw", () => {
    const db = freshDb();
    expect(() => deleteConversation(db, "nope")).not.toThrow();
  });

  it("does not touch other conversations of the same book", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const a = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const b = createConversation(db, { bookId: "book-1" });
    deleteConversation(db, a.id);
    expect(getConversation(db, b.id)?.id).toBe(b.id);
  });
});
