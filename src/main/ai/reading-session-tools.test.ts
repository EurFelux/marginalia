import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, readingSessions } from "@main/db/schema";
import { createReadingSessionTools } from "@main/ai/reading-session-tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books)
    .values([
      { id: "book-a", title: "A" },
      { id: "book-b", title: "B" },
    ])
    .run();
  return db;
}

async function run(tool: unknown, args: unknown) {
  return await (tool as { execute: (input: unknown) => Promise<unknown> }).execute(args);
}

describe("createReadingSessionTools", () => {
  it("lists only the current book's session metadata without report Markdown", async () => {
    const db = freshDb();
    db.insert(readingSessions)
      .values({
        id: "session-a",
        bookId: "book-a",
        startedAt: 1,
        completedAt: 2,
        report: "# A private report",
      })
      .run();
    db.insert(readingSessions)
      .values({ id: "session-b", bookId: "book-b", startedAt: 1, completedAt: 2, report: "# B" })
      .run();

    const tools = createReadingSessionTools({ db, scopedBookId: "book-a" });
    const sessions = await run(tools.listReadingSessions, {});

    expect(sessions).toEqual([
      expect.objectContaining({ id: "session-a", bookId: "book-a", reportAvailable: true }),
    ]);
    expect(sessions).not.toContainEqual(expect.objectContaining({ report: expect.anything() }));
    await expect(run(tools.listReadingSessions, { bookId: "book-b" })).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/current book/) }),
    );
  });

  it("allows library chat to list sessions for an explicitly requested book", async () => {
    const db = freshDb();
    db.insert(readingSessions)
      .values({ id: "session-b", bookId: "book-b", startedAt: 1, completedAt: 2, report: "# B" })
      .run();

    const tools = createReadingSessionTools({ db, scopedBookId: null });

    await expect(run(tools.listReadingSessions, { bookId: "book-b" })).resolves.toHaveLength(1);
    await expect(run(tools.listReadingSessions, {})).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/bookId is required/) }),
    );
  });

  it("returns only saved reports from completed sessions in the accessible book", async () => {
    const db = freshDb();
    db.insert(readingSessions)
      .values([
        {
          id: "saved-report",
          bookId: "book-a",
          startedAt: 1,
          completedAt: 2,
          report: "  # Saved report  ",
        },
        { id: "no-report", bookId: "book-a", startedAt: 3, completedAt: 4 },
        { id: "active", bookId: "book-b", startedAt: 5 },
        {
          id: "other-book",
          bookId: "book-b",
          startedAt: 6,
          completedAt: 7,
          report: "# Other report",
        },
      ])
      .run();
    const tools = createReadingSessionTools({ db, scopedBookId: "book-a" });

    await expect(run(tools.getReadingReport, { sessionId: "saved-report" })).resolves.toEqual(
      expect.objectContaining({
        id: "saved-report",
        bookId: "book-a",
        reportAvailable: true,
        content: "# Saved report",
      }),
    );
    await expect(run(tools.getReadingReport, { sessionId: "no-report" })).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/completed reading session with a report/),
      }),
    );
    await expect(run(tools.getReadingReport, { sessionId: "active" })).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/completed reading session with a report/),
      }),
    );
    await expect(run(tools.getReadingReport, { sessionId: "other-book" })).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/current book/) }),
    );
  });
});
