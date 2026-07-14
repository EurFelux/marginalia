import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  completeReading,
  getActiveReadingSession,
  listReadingSessions,
  startReading,
  toReadingSessionSummary,
} from "@main/reading-sessions/repository";
import {
  cancelReadingReportGeneration,
  getReadingSessionDetail,
  saveUserReadingReport,
  startReadingReportGeneration,
} from "@main/reading-report/service";
import { makeReadingReportDeps } from "@main/ai/send-deps";
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
    const db = getDb();
    if (!getActiveReadingSession(db, input.bookId)) {
      throw new Error(`book ${input.bookId} has no active reading session`);
    }
    const clock = getReadingClock();
    const ownsTargetBook = clock.getReadingBook() === input.bookId;
    if (ownsTargetBook) clock.tick();
    const completed = completeReading(db, input.bookId, Temporal.Now.instant());
    if (ownsTargetBook) clock.setReadingBook(null);
    return toReadingSessionSummary(db, completed);
  }),
  bind(C.readingSessionsList, (input) => listReadingSessions(getDb(), input.bookId)),
  bind(C.readingSessionsGet, (input) =>
    getReadingSessionDetail(makeReadingReportDeps(), input.sessionId),
  ),
  bind(C.readingSessionsGenerateReport, (input) =>
    startReadingReportGeneration(makeReadingReportDeps(), input.sessionId),
  ),
  bind(C.readingSessionsCancelReport, (input) =>
    cancelReadingReportGeneration(makeReadingReportDeps(), input.sessionId),
  ),
  bind(C.readingSessionsSaveReport, (input) =>
    saveUserReadingReport(makeReadingReportDeps(), input.sessionId, input.content),
  ),
];

export function registerReadingSessionHandlers(): void {
  register(readingSessionBindings);
}
