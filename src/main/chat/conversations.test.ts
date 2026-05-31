// src/main/chat/conversations.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters, conversations } from "@main/db/schema";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
  routeConversation,
} from "@main/chat/conversations";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedBookWithChapters(db: ReturnType<typeof freshDb>) {
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
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
  it("creates a conversation bound to the default assistant", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const convo = createConversation(db, { bookId: "book-1", chapterId: null });
    expect(convo.bookId).toBe("book-1");
    expect(convo.chapterId).toBeNull();
    expect(convo.assistantId).not.toBeNull();
    expect(getConversation(db, convo.id)?.id).toBe(convo.id);
  });

  it("getConversation returns null for an unknown id", () => {
    const db = freshDb();
    expect(getConversation(db, "nope")).toBeNull();
  });

  it("lists conversations for a book most-recently-updated first", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const a = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const b = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    // 显式设定不同 updatedAt，避免同毫秒打平导致排序不确定
    db.update(conversations).set({ updatedAt: 1 }).where(eq(conversations.id, a.id)).run();
    db.update(conversations).set({ updatedAt: 2 }).where(eq(conversations.id, b.id)).run();
    const list = listConversationsByBook(db, "book-1");
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });
});

describe("routeConversation", () => {
  it("creates a new chapter conversation when none exists and there is no active one", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: null,
    });
    expect(r.created).toBe(true);
    expect(r.switchedFromActive).toBe(false);
    expect(getConversation(db, r.conversationId)?.chapterId).toBe(ch1);
  });

  it("appends to the active conversation when it is bound to the current chapter", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r).toEqual({ conversationId: active.id, created: false, switchedFromActive: false });
  });

  it("appends to the active conversation when it is independent (chapterId null)", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: null });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).toBe(active.id);
    expect(r.switchedFromActive).toBe(false);
  });

  it("switches away from an active conversation bound to a different chapter (creating if needed)", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).not.toBe(active.id);
    expect(r.created).toBe(true);
    expect(r.switchedFromActive).toBe(true);
    expect(getConversation(db, r.conversationId)?.chapterId).toBe(ch1);
  });

  it("switches to an existing chapter conversation rather than creating a duplicate", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const existing = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const active = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).toBe(existing.id);
    expect(r.created).toBe(false);
    expect(r.switchedFromActive).toBe(true);
  });

  it("treats a stale (nonexistent) activeConversationId as no active conversation", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: "does-not-exist",
    });
    expect(r.created).toBe(true);
    expect(r.switchedFromActive).toBe(false);
  });

  it("flags switchedFromActive when the active conversation belongs to a different book", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    db.insert(books).values({ id: "book-2", path: "/tmp/b.epub" }).run();
    const otherBookConvo = createConversation(db, { bookId: "book-2", chapterId: null });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: otherBookConvo.id,
    });
    expect(r.conversationId).not.toBe(otherBookConvo.id);
    expect(r.switchedFromActive).toBe(true);
  });
});
