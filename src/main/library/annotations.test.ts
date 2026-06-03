import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { annotations, books } from "@main/db/schema";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1" }).run();
  return db;
}

const base = {
  bookId: "book-1",
  style: "yellow" as const,
  note: "",
  selectedText: "hello world",
  cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:5)",
};

describe("annotations repository", () => {
  it("creates and lists by book", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    expect(a.id).toBeTruthy();
    expect(a.style).toBe("yellow");
    expect(a.note).toBe("");
    const list = listAnnotationsByBook(db, "book-1");
    expect(list.map((x) => x.id)).toEqual([a.id]);
  });

  it("updates style and note", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    const u = updateAnnotation(db, { id: a.id, patch: { style: "green", note: "my note" } });
    expect(u.style).toBe("green");
    expect(u.note).toBe("my note");
    expect(u.updatedAt).toBeGreaterThanOrEqual(a.createdAt);
  });

  it("throws for unknown annotation on update", () => {
    const db = freshDb();
    expect(() =>
      updateAnnotation(db, { id: "00000000-0000-0000-0000-000000000000", patch: { note: "x" } }),
    ).toThrow(/annotation .* not found/);
  });

  it("lists most-recently-created first", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    const b = createAnnotation(db, { ...base, selectedText: "second" });
    // 强制不同的 createdAt，避免同毫秒插入导致顺序不确定。
    db.update(annotations).set({ createdAt: 1 }).where(eq(annotations.id, a.id)).run();
    db.update(annotations).set({ createdAt: 2 }).where(eq(annotations.id, b.id)).run();
    expect(listAnnotationsByBook(db, "book-1").map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("deletes", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    deleteAnnotation(db, a.id);
    expect(listAnnotationsByBook(db, "book-1")).toEqual([]);
  });

  it("throws for unknown book on create", () => {
    const db = freshDb();
    expect(() => createAnnotation(db, { ...base, bookId: "no-such" })).toThrow(/book .* not found/);
  });

  it("rejects an invalid style at the DB CHECK", () => {
    const db = freshDb();
    expect(() =>
      db
        .insert(annotations)
        .values({ bookId: "book-1", style: "rainbow", selectedText: "x", cfiRange: "epubcfi(/1)" })
        .run(),
    ).toThrow();
  });
});
