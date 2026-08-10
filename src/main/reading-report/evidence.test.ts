import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import {
  annotations,
  bookNotes,
  books,
  conversations,
  messages,
  readingSessions,
} from "@main/db/schema";
import {
  hasReaderEvidence,
  listSessionAnnotations,
  listSessionBookNotes,
  listSessionConversations,
  readSessionConversation,
  SESSION_CONVERSATION_TOKEN_BUDGET,
} from "@main/reading-report/evidence";
import { estimateTokens } from "@shared/tokens";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const startedAt = Temporal.Instant.from("2026-07-01T00:00:00Z").epochMilliseconds;
const completedAt = Temporal.Instant.from("2026-07-10T00:00:00Z").epochMilliseconds;
const before = Temporal.Instant.from("2026-06-30T23:59:59Z").epochMilliseconds;
const inside = Temporal.Instant.from("2026-07-05T00:00:00Z").epochMilliseconds;
const after = Temporal.Instant.from("2026-07-10T00:00:01Z").epochMilliseconds;

function setup() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books)
    .values([{ id: "book-1" }, { id: "book-2" }])
    .run();
  const session = db
    .insert(readingSessions)
    .values({ bookId: "book-1", startedAt, completedAt })
    .returning()
    .get();

  db.insert(annotations)
    .values([
      {
        bookId: "book-1",
        style: "yellow",
        note: "",
        selectedText: "created before",
        locatorRange: "before",
        createdAt: before,
        updatedAt: before,
      },
      {
        bookId: "book-1",
        style: "yellow",
        note: "",
        selectedText: "created inside",
        locatorRange: "inside",
        createdAt: inside,
        updatedAt: inside,
      },
      {
        bookId: "book-1",
        style: "yellow",
        note: "",
        selectedText: "updated inside",
        locatorRange: "updated",
        createdAt: before,
        updatedAt: inside,
      },
      {
        bookId: "book-1",
        style: "yellow",
        note: "",
        selectedText: "created after",
        locatorRange: "after",
        createdAt: after,
        updatedAt: after,
      },
    ])
    .run();
  db.insert(bookNotes)
    .values([
      { bookId: "book-1", content: "before", createdAt: before, updatedAt: before },
      {
        bookId: "book-1",
        content: "changed during this reading",
        createdAt: before,
        updatedAt: inside,
      },
      { bookId: "book-1", content: "after", createdAt: after, updatedAt: after },
    ])
    .run();

  const inWindow = db
    .insert(conversations)
    .values({ id: "conversation-in-window", bookId: "book-1" })
    .returning()
    .get();
  const outOfWindow = db
    .insert(conversations)
    .values({ id: "conversation-out-of-window", bookId: "book-1" })
    .returning()
    .get();
  const otherBook = db
    .insert(conversations)
    .values({ id: "conversation-other-book", bookId: "book-2" })
    .returning()
    .get();
  db.insert(messages)
    .values([
      {
        conversationId: inWindow.id,
        role: "user",
        parts: [{ type: "text", text: "before" }],
        seq: 0,
        createdAt: before,
      },
      {
        conversationId: inWindow.id,
        role: "assistant",
        parts: [{ type: "text", text: "inside one" }],
        seq: 1,
        createdAt: inside,
      },
      {
        conversationId: inWindow.id,
        role: "user",
        parts: [{ type: "text", text: "inside two" }],
        seq: 2,
        createdAt: inside,
      },
      {
        conversationId: inWindow.id,
        role: "assistant",
        parts: [{ type: "text", text: "after" }],
        seq: 3,
        createdAt: after,
      },
      {
        conversationId: outOfWindow.id,
        role: "user",
        parts: [{ type: "text", text: "outside" }],
        seq: 0,
        createdAt: before,
      },
      {
        conversationId: otherBook.id,
        role: "user",
        parts: [{ type: "text", text: "other book" }],
        seq: 0,
        createdAt: inside,
      },
    ])
    .run();
  return { db, session, otherBook };
}

describe("session evidence", () => {
  it("returns only annotations, notes, and conversations evidenced in the completed session window", () => {
    const { db, session } = setup();

    expect(listSessionAnnotations(db, session)).toEqual([
      expect.objectContaining({ selectedText: "created inside" }),
      expect.objectContaining({ selectedText: "updated inside" }),
    ]);
    expect(listSessionBookNotes(db, session)).toEqual([
      expect.objectContaining({ content: "changed during this reading" }),
    ]);
    expect(listSessionConversations(db, session).map((c) => c.id)).toEqual([
      "conversation-in-window",
    ]);
    expect(hasReaderEvidence(db, session)).toBe(true);
  });

  it("reports in-window size and compaction availability for each listed conversation", () => {
    const { db, session } = setup();

    const [listed] = listSessionConversations(db, session);
    // 窗口外的 seq 0 与 seq 3 不计入——规模须与模型随后能读到的范围一致。
    expect(listed).toEqual(
      expect.objectContaining({
        id: "conversation-in-window",
        messageCount: 2,
        estimatedTokens: estimateTokens("inside one") + estimateTokens("inside two"),
        hasCompactedContext: false,
      }),
    );
  });

  it("flags a conversation that carries a compacted summary", () => {
    const { db, session } = setup();
    db.update(conversations)
      .set({ contextSummary: "EARLY SUMMARY", summarizedThroughSeq: 1 })
      .where(eq(conversations.id, "conversation-in-window"))
      .run();

    expect(listSessionConversations(db, session)[0]).toEqual(
      expect.objectContaining({ hasCompactedContext: true }),
    );
  });

  it("returns in-window messages with one adjacent neighbor on each side in seq order", () => {
    const { db, session } = setup();

    const result = readSessionConversation(db, session, "conversation-in-window", {});

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.messages).toEqual([
      expect.objectContaining({ seq: 0, text: "before", context: "neighbor" }),
      expect.objectContaining({ seq: 1, text: "inside one", context: "session" }),
      expect.objectContaining({ seq: 2, text: "inside two", context: "session" }),
      expect.objectContaining({ seq: 3, text: "after", context: "neighbor" }),
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.nextAfterSeq).toBeNull();
  });

  it("rejects a conversation from another book", () => {
    const { db, session, otherBook } = setup();

    expect(() => readSessionConversation(db, session, otherBook.id, {})).toThrow(
      /not found for this book/,
    );
  });

  it("returns the compacted summary but never raw messages at or before its frontier", () => {
    const { db, session } = setup();
    db.update(conversations)
      .set({ contextSummary: "EARLY SUMMARY", summarizedThroughSeq: 1 })
      .where(eq(conversations.id, "conversation-in-window"))
      .run();

    const result = readSessionConversation(db, session, "conversation-in-window", {});

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.compactedContext).toEqual({ summary: "EARLY SUMMARY", throughSeq: 1 });
    expect(JSON.stringify(result)).not.toContain('"text":"before"');
    expect(JSON.stringify(result)).not.toContain('"text":"inside one"');
    expect(result.messages.map((message) => message.seq)).toEqual([2, 3]);
  });

  it("returns a compacted-only result when every in-session message is behind the frontier", () => {
    const { db, session } = setup();
    db.update(conversations)
      .set({ contextSummary: "ALL SESSION TURNS", summarizedThroughSeq: 2 })
      .where(eq(conversations.id, "conversation-in-window"))
      .run();

    expect(readSessionConversation(db, session, "conversation-in-window", {})).toEqual({
      status: "compacted-only",
      compactedContext: { summary: "ALL SESSION TURNS", throughSeq: 2 },
      messages: [],
    });
  });

  it("paginates uncompacted in-session messages with an exclusive seq cursor", () => {
    const { db, session } = setup();

    const first = readSessionConversation(db, session, "conversation-in-window", { limit: 1 });
    expect(first).toEqual(
      expect.objectContaining({ status: "messages", hasMore: true, nextAfterSeq: 1 }),
    );
    const second = readSessionConversation(db, session, "conversation-in-window", {
      afterSeq: 1,
      limit: 1,
    });
    expect(second).toEqual(
      expect.objectContaining({ status: "messages", hasMore: false, nextAfterSeq: null }),
    );
    if (second.status !== "messages") throw new Error("expected second message page");
    expect(second.messages.map((message) => message.seq)).toEqual([2, 3]);
  });

  it("caps returned message text at the token budget and marks truncation", () => {
    const { db, session } = setup();
    // CJK：1 字符 ≈ 1 token，故字符数直接对应预算——按字符记账时这条曾能整条通过。
    db.insert(messages)
      .values({
        conversationId: "conversation-in-window",
        role: "assistant",
        parts: [{ type: "text", text: "喵".repeat(SESSION_CONVERSATION_TOKEN_BUDGET + 100) }],
        seq: 4,
        createdAt: inside,
      })
      .run();

    const result = readSessionConversation(db, session, "conversation-in-window", {
      afterSeq: 3,
    });

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        seq: 4,
        truncated: true,
        text: "喵".repeat(SESSION_CONVERSATION_TOKEN_BUDGET),
      }),
    );
  });

  it("counts latin text at roughly a quarter token per character", () => {
    const { db, session } = setup();
    // 同样长度的拉丁文本约为 1/4 token，应整条返回而不被截断。
    db.insert(messages)
      .values({
        conversationId: "conversation-in-window",
        role: "assistant",
        parts: [{ type: "text", text: "x".repeat(SESSION_CONVERSATION_TOKEN_BUDGET + 100) }],
        seq: 4,
        createdAt: inside,
      })
      .run();

    const result = readSessionConversation(db, session, "conversation-in-window", {
      afterSeq: 3,
    });

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.messages[0]).toEqual(expect.objectContaining({ seq: 4, truncated: false }));
  });

  it("rejects an oversized page for the main agent but honors a raised ceiling", () => {
    const { db, session } = setup();

    expect(() =>
      readSessionConversation(db, session, "conversation-in-window", { limit: 200 }),
    ).toThrow(/between 1 and 50/);
    expect(() =>
      readSessionConversation(db, session, "conversation-in-window", {
        limit: 200,
        maxLimit: 500,
      }),
    ).not.toThrow();
  });

  it("honors an overridden token budget", () => {
    const { db, session } = setup();
    db.insert(messages)
      .values({
        conversationId: "conversation-in-window",
        role: "assistant",
        parts: [{ type: "text", text: "喵".repeat(50) }],
        seq: 4,
        createdAt: inside,
      })
      .run();

    const result = readSessionConversation(db, session, "conversation-in-window", {
      afterSeq: 3,
      tokenBudget: 10,
    });

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.messages[0]).toEqual(
      expect.objectContaining({ seq: 4, truncated: true, text: "喵".repeat(10) }),
    );
  });

  it("continues from the last returned session message when the text budget fills first", () => {
    const { db, session } = setup();
    const conversation = db
      .insert(conversations)
      .values({ id: "conversation-budget", bookId: "book-1" })
      .returning()
      .get();
    db.insert(messages)
      .values(
        [0, 1, 2, 3].map((seq) => ({
          conversationId: conversation.id,
          role: seq % 2 === 0 ? ("user" as const) : ("assistant" as const),
          parts: [{ type: "text" as const, text: "喵".repeat(8_000) }],
          seq,
          createdAt: inside,
        })),
      )
      .run();

    const first = readSessionConversation(db, session, conversation.id, {});
    if (first.status !== "messages") throw new Error("expected first message page");
    expect(first.messages.map((message) => message.seq)).toEqual([0, 1, 2]);
    expect(first).toEqual(expect.objectContaining({ hasMore: true, nextAfterSeq: 2 }));

    const second = readSessionConversation(db, session, conversation.id, { afterSeq: 2 });
    if (second.status !== "messages") throw new Error("expected second message page");
    expect(second.messages.map((message) => message.seq)).toEqual([3]);
    expect(second).toEqual(expect.objectContaining({ hasMore: false, nextAfterSeq: null }));
  });

  it("does not return a neighboring message at the compaction frontier", () => {
    const { db, session } = setup();
    db.update(conversations)
      .set({ contextSummary: "EARLY SUMMARY", summarizedThroughSeq: 1 })
      .where(eq(conversations.id, "conversation-in-window"))
      .run();

    const result = readSessionConversation(db, session, "conversation-in-window", {});

    if (result.status !== "messages") throw new Error("expected raw tail messages");
    expect(result.messages.some((message) => message.seq <= 1)).toBe(false);
  });
});
