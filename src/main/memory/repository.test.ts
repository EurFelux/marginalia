import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import { memories } from "@main/db/schema";
import {
  applyReadingReportMemoryMutations,
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
    });
    expect(m.slug).toBe("econ-framework");
    expect(getMemoryBySlug(db, "econ-framework")?.id).toBe(m.id);
  });

  it("rejects duplicate slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "a", title: "t", description: "d", body: "b" });
    expect(() =>
      createMemory(db, {
        slug: "a",
        title: "t2",
        description: "d2",
        body: "b2",
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
    });
    const m = createMemory(db, {
      slug: "source",
      title: "t",
      description: "d",
      body: "links [[target]] and [[not-yet]]",
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
    });
    const b = createMemory(db, {
      slug: "b",
      title: "t",
      description: "d",
      body: "see [[a]]",
    });
    updateMemoryById(db, { id: b.id, body: "no links now" });
    expect(getMemoryBySlug(db, "a")?.incoming).toEqual([]);
    updateMemoryById(db, { id: b.id, body: "back to [[a]]" });
    deleteMemoryById(db, a.id);
    // a 删除后：b 的 body 文本不动，[[a]] 转为悬空
    expect(getMemoryBySlug(db, "b")?.danglingLinks).toEqual(["a"]);
  });

  it("returns outgoing links in body appearance order", () => {
    const db = freshDb();
    createMemory(db, { slug: "zz", title: "t", description: "d", body: "b" });
    createMemory(db, { slug: "aa", title: "t", description: "d", body: "b" });
    createMemory(db, {
      slug: "src",
      title: "t",
      description: "d",
      body: "first [[zz]] then [[aa]]",
    });
    expect(getMemoryBySlug(db, "src")?.outgoing.map((o) => o.slug)).toEqual(["zz", "aa"]);
  });

  it("lists memories with stable order (createdAt, id)", () => {
    const db = freshDb();
    createMemory(db, { slug: "m1", title: "t1", description: "d1", body: "b" });
    createMemory(db, { slug: "m2", title: "t2", description: "d2", body: "b" });
    expect(listMemories(db).map((m) => m.slug)).toEqual(["m1", "m2"]);
  });

  it("applies a report memory batch with links at one injected timestamp", () => {
    const db = freshDb();
    const committedAt = 1_783_459_200_000;

    db.transaction((tx) => {
      applyReadingReportMemoryMutations(
        tx,
        [
          { kind: "create", slug: "a", title: "A", description: "A", body: "[[b]]" },
          { kind: "create", slug: "b", title: "B", description: "B", body: "B" },
        ],
        committedAt,
      );
    });

    expect(getMemoryBySlug(db, "a")?.outgoing.map((memory) => memory.slug)).toEqual(["b"]);
    expect(getMemoryBySlug(db, "a")?.createdAt).toBe(committedAt);
    expect(getMemoryBySlug(db, "a")?.updatedAt).toBe(committedAt);
  });

  it("rejects an optimistic report update when the original memory changed", () => {
    const db = freshDb();
    const original = createMemory(db, {
      slug: "durable-insight",
      title: "Durable insight",
      description: "Description.",
      body: "Original body.",
    });
    db.update(memories)
      .set({ body: "Changed elsewhere.", updatedAt: original.updatedAt + 1 })
      .where(eq(memories.id, original.id))
      .run();

    expect(() =>
      db.transaction((tx) =>
        applyReadingReportMemoryMutations(
          tx,
          [
            {
              kind: "update",
              id: original.id,
              slug: original.slug,
              expectedUpdatedAt: original.updatedAt,
              title: original.title,
              description: original.description,
              body: "Report update.",
            },
          ],
          original.updatedAt + 10,
        ),
      ),
    ).toThrow(/changed during reading report generation/);
    expect(getMemoryBySlug(db, original.slug)?.body).toBe("Changed elsewhere.");
  });
});
