import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books, readingDaily, readingSessions } from "@main/db/schema";
import { readingSessionSeconds } from "@main/reading-sessions/repository";
import { addSeconds, dailyTotals, perBookTotals } from "@main/stats/reading-daily";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function insertBook(db: DB, id: string, title: string | null) {
  db.insert(books).values({ id, title, author: null }).run();
}

describe("reading-daily repository", () => {
  let db: DB;
  beforeEach(() => {
    db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
  });

  it("addSeconds upserts and accumulates per (session, day)", () => {
    insertBook(db, "b1", "Book 1");
    const session = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-09", seconds: 30 });
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-09", seconds: 15 });
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-10", seconds: 20 });
    expect(dailyTotals(db)).toEqual([
      { day: "2026-06-09", seconds: 45 },
      { day: "2026-06-10", seconds: 20 },
    ]);
  });

  it("ignores non-positive seconds", () => {
    insertBook(db, "b1", "Book 1");
    const session = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-09", seconds: 0 });
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-09", seconds: -5 });
    expect(dailyTotals(db)).toEqual([]);
  });

  it("dailyTotals sums across books per day", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    const first = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    const second = db
      .insert(readingSessions)
      .values({ bookId: "b2", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: first.id, day: "2026-06-09", seconds: 30 });
    addSeconds(db, { bookId: "b2", readingSessionId: second.id, day: "2026-06-09", seconds: 70 });
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 100 }]);
  });

  it("perBookTotals ranks existing books desc", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    const first = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    const second = db
      .insert(readingSessions)
      .values({ bookId: "b2", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: first.id, day: "2026-06-09", seconds: 100 });
    addSeconds(db, { bookId: "b2", readingSessionId: second.id, day: "2026-06-09", seconds: 300 });
    expect(perBookTotals(db)).toEqual([
      { bookId: "b2", title: "Book 2", author: null, seconds: 300 },
      { bookId: "b1", title: "Book 1", author: null, seconds: 100 },
    ]);
  });

  it("preserves time history on book delete (set null): still in dailyTotals, gone from perBook", () => {
    insertBook(db, "b1", "Book 1");
    const session = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-06-09", seconds: 120 });
    db.delete(books).where(eq(books.id, "b1")).run();
    // 删书后 bookId set null：仍计入每日合计，但不再出现在各书排行。
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 120 }]);
    expect(perBookTotals(db)).toEqual([]);
  });

  it("keeps same-day facts separate by session while aggregating book and day totals", () => {
    insertBook(db, "b1", "Book 1");
    const first = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1, completedAt: 2 })
      .returning()
      .get();
    const second = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 3 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: first.id, day: "2026-07-14", seconds: 30 });
    addSeconds(db, { bookId: "b1", readingSessionId: second.id, day: "2026-07-14", seconds: 45 });
    expect(readingSessionSeconds(db, first.id)).toBe(30);
    expect(readingSessionSeconds(db, second.id)).toBe(45);
    expect(dailyTotals(db)).toEqual([{ day: "2026-07-14", seconds: 75 }]);
    expect(perBookTotals(db)[0]?.seconds).toBe(75);
  });

  it("nulls session and book foreign keys without losing daily history", () => {
    insertBook(db, "b1", "Book 1");
    const session = db
      .insert(readingSessions)
      .values({ bookId: "b1", startedAt: 1 })
      .returning()
      .get();
    addSeconds(db, { bookId: "b1", readingSessionId: session.id, day: "2026-07-14", seconds: 30 });
    db.delete(readingSessions).where(eq(readingSessions.id, session.id)).run();
    expect(db.select().from(readingDaily).get()?.readingSessionId).toBeNull();
    db.delete(books).where(eq(books.id, "b1")).run();
    expect(db.select().from(readingDaily).get()).toMatchObject({
      bookId: null,
      readingSessionId: null,
    });
    expect(dailyTotals(db)).toEqual([{ day: "2026-07-14", seconds: 30 }]);
  });
});
