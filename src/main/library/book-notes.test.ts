import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { bookNotes, books } from "@main/db/schema";
import {
  createBookNote,
  deleteBookNote,
  listBookNotesByBook,
  updateBookNote,
} from "@main/library/book-notes";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1" }).run();
  return db;
}

describe("book notes repository", () => {
  it("creates and lists by book", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "# 读后感" });
    expect(n.id).toBeTruthy();
    expect(n.content).toBe("# 读后感");
    expect(listBookNotesByBook(db, "book-1").map((x) => x.id)).toEqual([n.id]);
  });

  it("lists most-recently-created first", () => {
    const db = freshDb();
    const a = createBookNote(db, { bookId: "book-1", content: "first" });
    const b = createBookNote(db, { bookId: "book-1", content: "second" });
    // 强制不同 createdAt，避免同毫秒插入导致顺序不确定。
    db.update(bookNotes).set({ createdAt: 1 }).where(eq(bookNotes.id, a.id)).run();
    db.update(bookNotes).set({ createdAt: 2 }).where(eq(bookNotes.id, b.id)).run();
    expect(listBookNotesByBook(db, "book-1").map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("updates content and refreshes updatedAt", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "old" });
    // 把 updatedAt 拨回过去，确保 update 后严格变大（不依赖毫秒间隔）。
    db.update(bookNotes).set({ updatedAt: 1 }).where(eq(bookNotes.id, n.id)).run();
    const u = updateBookNote(db, { id: n.id, patch: { content: "new **md**" } });
    expect(u.content).toBe("new **md**");
    expect(u.updatedAt).toBeGreaterThan(1);
  });

  it("throws for unknown note on update", () => {
    const db = freshDb();
    expect(() =>
      updateBookNote(db, { id: "00000000-0000-0000-0000-000000000000", patch: { content: "x" } }),
    ).toThrow(/book note .* not found/);
  });

  it("deletes", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "bye" });
    deleteBookNote(db, n.id);
    expect(listBookNotesByBook(db, "book-1")).toEqual([]);
  });

  it("throws for unknown note on delete", () => {
    const db = freshDb();
    expect(() => deleteBookNote(db, "no-such")).toThrow(/book note .* not found/);
  });

  it("throws for unknown book on create", () => {
    const db = freshDb();
    expect(() => createBookNote(db, { bookId: "no-such", content: "x" })).toThrow(
      /book .* not found/,
    );
  });

  it("cascades on book delete", () => {
    const db = freshDb();
    createBookNote(db, { bookId: "book-1", content: "will vanish" });
    db.delete(books).where(eq(books.id, "book-1")).run();
    expect(db.select().from(bookNotes).all()).toEqual([]);
  });
});
