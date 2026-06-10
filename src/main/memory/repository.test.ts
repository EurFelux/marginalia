import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  listMemories,
  updateMemoryById,
} from "@main/memory/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("memories repository", () => {
  it("creates and reads a memory by slug", () => {
    const db = freshDb();
    const m = createMemory(db, {
      slug: "econ-framework",
      title: "经济学框架",
      description: "用经济学框架理解社会问题",
      body: "详细正文",
      sourceBookId: null,
    });
    expect(m.slug).toBe("econ-framework");
    expect(getMemoryBySlug(db, "econ-framework")?.id).toBe(m.id);
  });

  it("rejects duplicate slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "a", title: "t", description: "d", body: "b", sourceBookId: null });
    expect(() =>
      createMemory(db, {
        slug: "a",
        title: "t2",
        description: "d2",
        body: "b2",
        sourceBookId: null,
      }),
    ).toThrow();
  });

  it("syncs memory_links from body, ignoring dangling slugs", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "target",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const m = createMemory(db, {
      slug: "source",
      title: "t",
      description: "d",
      body: "links [[target]] and [[not-yet]]",
      sourceBookId: null,
    });
    const read = getMemoryBySlug(db, "source");
    expect(read?.outgoing.map((o) => o.slug)).toEqual(["target"]);
    expect(read?.danglingLinks).toEqual(["not-yet"]);
    const target = getMemoryBySlug(db, "target");
    expect(target?.incoming.map((i) => i.slug)).toEqual(["source"]);
    expect(m.id).toBeTruthy();
  });

  it("re-syncs links on body update and clears edges on delete", () => {
    const db = freshDb();
    const a = createMemory(db, {
      slug: "a",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const b = createMemory(db, {
      slug: "b",
      title: "t",
      description: "d",
      body: "see [[a]]",
      sourceBookId: null,
    });
    updateMemoryById(db, { id: b.id, body: "no links now" });
    expect(getMemoryBySlug(db, "a")?.incoming).toEqual([]);
    updateMemoryById(db, { id: b.id, body: "back to [[a]]" });
    deleteMemoryById(db, a.id);
    // a 删除后：b 的 body 文本不动，[[a]] 转为悬空
    expect(getMemoryBySlug(db, "b")?.danglingLinks).toEqual(["a"]);
  });

  it("keeps memory on book deletion (sourceBookId SET NULL)", () => {
    const db = freshDb();
    db.insert(books).values({ id: "book-1", title: "Book One" }).run();
    createMemory(db, {
      slug: "m",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: "book-1",
    });
    db.delete(books).where(eq(books.id, "book-1")).run();
    expect(listMemories(db)[0].sourceBookId).toBeNull();
  });

  it("lists memories with stable order (createdAt, id)", () => {
    const db = freshDb();
    createMemory(db, { slug: "m1", title: "t1", description: "d1", body: "b", sourceBookId: null });
    createMemory(db, { slug: "m2", title: "t2", description: "d2", body: "b", sourceBookId: null });
    expect(listMemories(db).map((m) => m.slug)).toEqual(["m1", "m2"]);
  });
});
