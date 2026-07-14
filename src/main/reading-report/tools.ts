import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { createReadingTools, runTool, type LoadBytes } from "@main/ai/tools";
import {
  getReadingSession,
  listReadingSessionRows,
  readingSessionSeconds,
  toReadingSessionSummary,
  type ReadingSessionRow,
} from "@main/reading-sessions/repository";
import {
  listSessionAnnotations,
  listSessionBookNotes,
  listSessionConversations,
  readSessionConversation,
} from "@main/reading-report/evidence";

export interface ReadingReportToolsDeps {
  db: DB;
  session: ReadingSessionRow;
  loadBytes: LoadBytes;
  imageToolResults: boolean;
}

export function createReadingReportTools(deps: ReadingReportToolsDeps) {
  const pageInput = z.object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(100).default(50),
  });
  const page = <T>(rows: T[], offset: number, limit: number) => ({
    items: rows.slice(offset, offset + limit),
    hasMore: offset + limit < rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  });
  return {
    ...createReadingTools({
      db: deps.db,
      bookId: deps.session.bookId,
      loadBytes: deps.loadBytes,
      imageToolResults: deps.imageToolResults,
    }),
    listAnnotations: tool({
      description: "List annotations created or updated during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listAnnotations", () =>
          page(listSessionAnnotations(deps.db, deps.session), offset, limit),
        ),
    }),
    listBookNotes: tool({
      description: "List book notes created or updated during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listBookNotes", () =>
          page(listSessionBookNotes(deps.db, deps.session), offset, limit),
        ),
    }),
    listConversations: tool({
      description: "List conversations with messages during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listConversations", () =>
          page(listSessionConversations(deps.db, deps.session), offset, limit),
        ),
    }),
    readConversation: tool({
      description: "Read the in-session turns of one listed conversation with neighboring context.",
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) =>
        runTool("readConversation", () =>
          readSessionConversation(deps.db, deps.session, conversationId),
        ),
    }),
    listPreviousReadingSessions: tool({
      description: "List earlier completed readings of this book without report bodies.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listPreviousReadingSessions", () => {
          const rows = listReadingSessionRows(deps.db, deps.session.bookId).filter(
            (row) =>
              row.id !== deps.session.id &&
              row.completedAt !== null &&
              row.completedAt <= deps.session.startedAt,
          );
          return page(
            rows.map((row) => toReadingSessionSummary(deps.db, row)),
            offset,
            limit,
          );
        }),
    }),
    getPreviousReadingReport: tool({
      description: "Read the saved report from one earlier listed reading session.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      execute: async ({ sessionId }) =>
        runTool("getPreviousReadingReport", () => {
          const row = getReadingSession(deps.db, sessionId);
          if (!row || row.bookId !== deps.session.bookId || row.id === deps.session.id) {
            throw new Error("previous reading session not found for this book");
          }
          const content = row.report?.trim();
          if (!content) throw new Error("previous reading session has no report");
          return { ...toReadingSessionSummary(deps.db, row), content };
        }),
    }),
    getSessionReadingStats: tool({
      description: "Get active reading seconds for the current reading session.",
      inputSchema: z.object({}),
      execute: async () =>
        runTool("getSessionReadingStats", () => ({
          activeSeconds: readingSessionSeconds(deps.db, deps.session.id),
        })),
    }),
  };
}
