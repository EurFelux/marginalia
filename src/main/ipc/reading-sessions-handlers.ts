import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  completeReading,
  listReadingSessions,
  startReading,
  toReadingSessionSummary,
} from "@main/reading-sessions/repository";
import { bind, register, type Binding } from "@main/ipc/registry";
import { getReadingClock } from "@main/stats/clock-wiring";

export const readingSessionBindings: Binding[] = [
  bind(C.readingSessionsStart, (input) => {
    const db = getDb();
    return toReadingSessionSummary(
      db,
      startReading(db, { ...input, startedAt: Temporal.Now.instant() }),
    );
  }),
  bind(C.readingSessionsComplete, (input) => {
    getReadingClock().setReadingBook(null);
    const db = getDb();
    return toReadingSessionSummary(db, completeReading(db, input.bookId, Temporal.Now.instant()));
  }),
  bind(C.readingSessionsList, (input) => listReadingSessions(getDb(), input.bookId)),
];

export function registerReadingSessionHandlers(): void {
  register(readingSessionBindings);
}
