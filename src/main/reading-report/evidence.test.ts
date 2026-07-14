import path from "node:path";
import { describe, expect, it } from "vitest";
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
} from "@main/reading-report/evidence";

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

  it("returns in-window messages with one adjacent neighbor on each side in seq order", () => {
    const { db, session } = setup();

    expect(readSessionConversation(db, session, "conversation-in-window")).toEqual([
      expect.objectContaining({ seq: 0, text: "before" }),
      expect.objectContaining({ seq: 1, text: "inside one" }),
      expect.objectContaining({ seq: 2, text: "inside two" }),
      expect.objectContaining({ seq: 3, text: "after" }),
    ]);
  });

  it("rejects a conversation from another book", () => {
    const { db, session, otherBook } = setup();

    expect(() => readSessionConversation(db, session, otherBook.id)).toThrow(
      /not found for this book/,
    );
  });
});
