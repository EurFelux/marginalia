import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
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

  it("addSeconds upserts and accumulates per (book, day)", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 30);
    addSeconds(db, "b1", "2026-06-09", 15);
    addSeconds(db, "b1", "2026-06-10", 20);
    expect(dailyTotals(db)).toEqual([
      { day: "2026-06-09", seconds: 45 },
      { day: "2026-06-10", seconds: 20 },
    ]);
  });

  it("ignores non-positive seconds", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 0);
    addSeconds(db, "b1", "2026-06-09", -5);
    expect(dailyTotals(db)).toEqual([]);
  });

  it("dailyTotals sums across books per day", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    addSeconds(db, "b1", "2026-06-09", 30);
    addSeconds(db, "b2", "2026-06-09", 70);
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 100 }]);
  });

  it("perBookTotals ranks existing books desc", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    addSeconds(db, "b1", "2026-06-09", 100);
    addSeconds(db, "b2", "2026-06-09", 300);
    expect(perBookTotals(db)).toEqual([
      { bookId: "b2", title: "Book 2", author: null, seconds: 300 },
      { bookId: "b1", title: "Book 1", author: null, seconds: 100 },
    ]);
  });

  it("preserves time history on book delete (set null): still in dailyTotals, gone from perBook", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 120);
    db.delete(books).where(eq(books.id, "b1")).run();
    // 删书后 bookId set null：仍计入每日合计，但不再出现在各书排行。
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 120 }]);
    expect(perBookTotals(db)).toEqual([]);
  });
});
