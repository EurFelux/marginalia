import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { runTool } from "@main/ai/tools";
import {
  getReadingSession,
  listReadingSessions,
  toReadingSessionSummary,
} from "@main/reading-sessions/repository";

export interface ReadingSessionToolsDeps {
  db: DB;
  /** null = library chat; a book id = reader chat restricted to that book. */
  scopedBookId: string | null;
}

/** Read-only completion-report tools shared by reader and library chat contexts. */
export function createReadingSessionTools({ db, scopedBookId }: ReadingSessionToolsDeps) {
  return {
    listReadingSessions: tool({
      description:
        "List reading sessions for the current or requested library book without report bodies.",
      inputSchema: z.object({ bookId: z.string().min(1).optional() }),
      execute: async ({ bookId }) =>
        runTool("listReadingSessions", () => {
          const targetBookId = scopedBookId ?? bookId;
          if (!targetBookId) throw new Error("bookId is required in library context");
          if (scopedBookId && bookId && bookId !== scopedBookId) {
            throw new Error("cannot list sessions outside the current book");
          }
          return listReadingSessions(db, targetBookId);
        }),
    }),
    getReadingReport: tool({
      description: "Read one saved completion report by session id after listing sessions.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      execute: async ({ sessionId }) =>
        runTool("getReadingReport", () => {
          const session = getReadingSession(db, sessionId);
          const content = session?.report?.trim();
          if (!session || session.completedAt == null || !content) {
            throw new Error("completed reading session with a report not found");
          }
          if (scopedBookId && session.bookId !== scopedBookId) {
            throw new Error("session does not belong to the current book");
          }
          return { ...toReadingSessionSummary(db, session), content };
        }),
    }),
  };
}
