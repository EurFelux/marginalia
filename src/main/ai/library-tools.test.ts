import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, progress, annotations, bookNotes, readingDaily } from "@main/db/schema";
import { createLibraryTools } from "@main/ai/library-tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}
async function run(tool: unknown, args: unknown = {}) {
  // Cast through unknown: Tool.execute is typed optional in AI SDK v6 but always present for tools
  // created with the `tool()` helper; casting avoids the structural mismatch in tests.
  return await (tool as { execute: (a: unknown) => Promise<unknown> }).execute(args);
}

describe("createLibraryTools", () => {
  it("listBooks returns the catalog with progress + finished flags", async () => {
    const db = freshDb();
    db.insert(books)
      .values({ id: "b1", title: "Stoicism", author: "M.A.", isFinished: false })
      .run();
    db.insert(books).values({ id: "b2", title: "Done", isFinished: true }).run();
    db.insert(progress).values({ bookId: "b1", locator: "loc", percent: 0.4 }).run();
    const tools = createLibraryTools({ db });
    const list = (await run(tools.listBooks)) as Array<Record<string, unknown>>;
    expect(list.map((b) => b.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "b1",
      "b2",
    ]);
    const b1 = list.find((b) => b.id === "b1")!;
    expect(b1.title).toBe("Stoicism");
    expect(b1.progressPercent).toBe(0.4);
    expect(b1.isFinished).toBe(false);
  });
  it("getBook returns details; unknown id returns an error hint", async () => {
    const db = freshDb();
    db.insert(books).values({ id: "b1", title: "T", summary: "the gist" }).run();
    const tools = createLibraryTools({ db });
    const ok = (await run(tools.getBook, { bookId: "b1" })) as Record<string, unknown>;
    expect(ok.title).toBe("T");
    expect(ok.summary).toBe("the gist");
    const bad = (await run(tools.getBook, { bookId: "nope" })) as Record<string, unknown>;
    expect(bad.error).toBeTypeOf("string");
  });
  it("getBookNotes + listAnnotations return per-book entries", async () => {
    const db = freshDb();
    db.insert(books).values({ id: "b1", title: "T" }).run();
    db.insert(bookNotes).values({ bookId: "b1", content: "my note" }).run();
    db.insert(annotations)
      .values({
        bookId: "b1",
        style: "yellow",
        note: "",
        selectedText: "passage",
        locatorRange: "r",
      })
      .run();
    const tools = createLibraryTools({ db });
    const notes = (await run(tools.getBookNotes, { bookId: "b1" })) as Array<
      Record<string, unknown>
    >;
    expect(notes[0].content).toBe("my note");
    const anns = (await run(tools.listAnnotations, { bookId: "b1" })) as Array<
      Record<string, unknown>
    >;
    expect(anns[0].selectedText).toBe("passage");
  });

  it("getReadingStats returns totals over reading_daily", async () => {
    const db = freshDb();
    db.insert(books).values({ id: "b1", title: "T" }).run();
    db.insert(readingDaily).values({ bookId: "b1", day: "2026-06-15", seconds: 600 }).run();
    const stats = (await run(createLibraryTools({ db }).getReadingStats, {})) as Record<
      string,
      unknown
    >;
    expect(stats.totalSeconds).toBe(600);
  });
});
