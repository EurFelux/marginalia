import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import { books, readingSessions } from "@main/db/schema";
import {
  completeReading,
  getBookReadingState,
  getReadingSession,
  listReadingSessions,
  readingSessionSeconds,
  saveReadingReport,
  startReading,
} from "@main/reading-sessions/repository";
import { getProgress, saveProgress } from "@main/library/progress";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "b1" }).run();
  return db;
};

describe("reading sessions repository", () => {
  it("allows many completed sessions but only one active session per book", () => {
    const db = freshDb();
    const first = startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
    });
    completeReading(db, "b1", Temporal.Instant.from("2026-07-03T00:00:00Z"));
    const second = startReading(db, {
      bookId: "b1",
      mode: "restart",
      startedAt: Temporal.Instant.from("2026-07-10T00:00:00Z"),
    });
    expect(first.id).not.toBe(second.id);
    expect(() =>
      startReading(db, {
        bookId: "b1",
        mode: "continue",
        startedAt: Temporal.Instant.from("2026-07-11T00:00:00Z"),
      }),
    ).toThrow(/already has an active reading session/);
  });

  it("preserves progress for continue and clears it for restart", () => {
    const db = freshDb();
    saveProgress(db, "b1", "epubcfi(/6/2)", 0.6);
    startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
    });
    expect(getProgress(db, "b1")?.percent).toBe(0.6);
    completeReading(db, "b1", Temporal.Instant.from("2026-07-02T00:00:00Z"));
    startReading(db, {
      bookId: "b1",
      mode: "restart",
      startedAt: Temporal.Instant.from("2026-07-03T00:00:00Z"),
    });
    expect(getProgress(db, "b1")).toBeUndefined();
  });

  it("rejects completion before the session start", () => {
    const db = freshDb();
    startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-02T00:00:00Z"),
    });
    expect(() => completeReading(db, "b1", Temporal.Instant.from("2026-07-01T00:00:00Z"))).toThrow(
      /completed_after_start_check/i,
    );
  });

  it("only saves trimmed reports on completed sessions", () => {
    const db = freshDb();
    const active = startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
    });
    expect(() => saveReadingReport(db, active.id, "# Report")).toThrow(/active/i);
    completeReading(db, "b1", Temporal.Instant.from("2026-07-02T00:00:00Z"));
    expect(saveReadingReport(db, active.id, "  # Report  ").report).toBe("# Report");
    expect(() => saveReadingReport(db, active.id, "  ")).toThrow(/non-empty/i);
    expect(() => saveReadingReport(db, "missing", "# Report")).toThrow(/not found/i);
  });

  it("cascades sessions when deleting a book", () => {
    const db = freshDb();
    startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
    });
    db.delete(books).where(eq(books.id, "b1")).run();
    expect(db.select().from(readingSessions).all()).toEqual([]);
  });

  it("rejects restart before a completed session exists", () => {
    const db = freshDb();
    expect(() =>
      startReading(db, {
        bookId: "b1",
        mode: "restart",
        startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
      }),
    ).toThrow(/completed reading session/i);
  });

  it("derives session state, summaries, and duration without exposing report content", () => {
    const db = freshDb();
    const active = startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
    });
    expect(getBookReadingState(db, "b1")).toBe("reading");
    completeReading(db, "b1", Temporal.Instant.from("2026-07-02T00:00:00Z"));
    saveReadingReport(db, active.id, "# Report");
    expect(getReadingSession(db, active.id)?.completedAt).not.toBeNull();
    expect(getBookReadingState(db, "b1")).toBe("finished");
    expect(listReadingSessions(db, "b1")).toMatchObject([
      { id: active.id, bookId: "b1", reportAvailable: true, activeSeconds: 0 },
    ]);
    expect(readingSessionSeconds(db, active.id)).toBe(0);
  });
});
