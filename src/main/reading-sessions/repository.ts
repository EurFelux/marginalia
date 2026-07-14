import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, progress, readingDaily, readingSessions } from "@main/db/schema";
import type {
  BookReadingState,
  ReadingSessionSummaryDto,
  StartReadingInput,
} from "@shared/reading-sessions";

export type ReadingSessionRow = typeof readingSessions.$inferSelect;

export function getReadingSession(db: DB, sessionId: string): ReadingSessionRow | undefined {
  return db.select().from(readingSessions).where(eq(readingSessions.id, sessionId)).get();
}

export function getActiveReadingSession(db: DB, bookId: string): ReadingSessionRow | undefined {
  return db
    .select()
    .from(readingSessions)
    .where(and(eq(readingSessions.bookId, bookId), isNull(readingSessions.completedAt)))
    .get();
}

export function listReadingSessionRows(db: DB, bookId: string): ReadingSessionRow[] {
  return db
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.bookId, bookId))
    .orderBy(desc(readingSessions.startedAt))
    .all();
}

export function listReadingSessions(db: DB, bookId: string): ReadingSessionSummaryDto[] {
  return listReadingSessionRows(db, bookId).map((row) => toReadingSessionSummary(db, row));
}

export function getBookReadingState(db: DB, bookId: string): BookReadingState {
  if (getActiveReadingSession(db, bookId)) return "reading";
  const completed = db
    .select({ id: readingSessions.id })
    .from(readingSessions)
    .where(and(eq(readingSessions.bookId, bookId), isNotNull(readingSessions.completedAt)))
    .get();
  return completed ? "finished" : "not-started";
}

export function startReading(
  db: DB,
  input: StartReadingInput & { startedAt: Temporal.Instant },
): ReadingSessionRow {
  return db.transaction((tx) => {
    const book = tx.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).get();
    if (!book) throw new Error(`book not found: ${input.bookId}`);
    const active = tx
      .select({ id: readingSessions.id })
      .from(readingSessions)
      .where(and(eq(readingSessions.bookId, input.bookId), isNull(readingSessions.completedAt)))
      .get();
    if (active) {
      throw new Error(`book ${input.bookId} already has an active reading session`);
    }
    if (input.mode === "restart") {
      const completed = tx
        .select({ id: readingSessions.id })
        .from(readingSessions)
        .where(
          and(eq(readingSessions.bookId, input.bookId), isNotNull(readingSessions.completedAt)),
        )
        .get();
      if (!completed) throw new Error(`book ${input.bookId} has no completed reading session`);
      tx.delete(progress).where(eq(progress.bookId, input.bookId)).run();
    }
    return tx
      .insert(readingSessions)
      .values({ bookId: input.bookId, startedAt: input.startedAt.epochMilliseconds })
      .returning()
      .get();
  });
}

export function completeReading(
  db: DB,
  bookId: string,
  completedAt: Temporal.Instant,
): ReadingSessionRow {
  const active = getActiveReadingSession(db, bookId);
  if (!active) throw new Error(`book ${bookId} has no active reading session`);
  return db
    .update(readingSessions)
    .set({ completedAt: completedAt.epochMilliseconds })
    .where(eq(readingSessions.id, active.id))
    .returning()
    .get();
}

export function saveReadingReport(db: DB, sessionId: string, content: string): ReadingSessionRow {
  const report = content.trim();
  if (!report) throw new Error("reading report must be non-empty");
  const session = getReadingSession(db, sessionId);
  if (!session) throw new Error(`reading session not found: ${sessionId}`);
  if (session.completedAt == null)
    throw new Error("cannot save a report for an active reading session");
  return db
    .update(readingSessions)
    .set({ report })
    .where(eq(readingSessions.id, sessionId))
    .returning()
    .get();
}

export function readingSessionSeconds(db: DB, sessionId: string): number {
  return (
    db
      .select({ seconds: sql<number>`coalesce(sum(${readingDaily.seconds}), 0)` })
      .from(readingDaily)
      .where(eq(readingDaily.readingSessionId, sessionId))
      .get()?.seconds ?? 0
  );
}

export function toReadingSessionSummary(db: DB, row: ReadingSessionRow): ReadingSessionSummaryDto {
  return {
    id: row.id,
    bookId: row.bookId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    activeSeconds: readingSessionSeconds(db, row.id),
    reportAvailable: Boolean(row.report?.trim()),
  };
}
