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
import type { ConversationInvestigation } from "@main/reading-report/investigator";
import { createLogger } from "@main/logger";

const log = createLogger("report");

export interface ReadingReportToolsDeps {
  db: DB;
  session: ReadingSessionRow;
  loadBytes: LoadBytes;
  imageToolResults: boolean;
  /**
   * 派 subagent 调查一个会话。返回 null = 未拿到并发额度（主 agent 应自行翻页）。
   * 抛错交由工具层转 failed 降级。
   */
  investigate: (input: {
    conversationId: string;
    focus?: string;
  }) => Promise<ConversationInvestigation | null>;
}

const INVESTIGATION_FALLBACK = "read this conversation yourself with readConversation";

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
      description:
        "List conversations with messages during this reading session, each with its in-session size (messageCount, estimatedTokens) and whether a compacted background summary exists. Use the sizes to budget: read a small conversation yourself, and delegate a large one (roughly 30k tokens or more) to investigateConversation.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listConversations", () =>
          page(listSessionConversations(deps.db, deps.session), offset, limit),
        ),
    }),
    investigateConversation: tool({
      description:
        "Delegate one large conversation to an assistant that reads all of it and reports what the reader did: their questions, judgments, turning points, and connections, each with the seq range it came from. Read that range with readConversation when you want the reader's own words. Returns status busy or failed when delegation is unavailable — page the conversation yourself in that case.",
      inputSchema: z.object({
        conversationId: z.string().min(1),
        focus: z.string().optional(),
      }),
      execute: async ({ conversationId, focus }) => {
        try {
          const investigation = await deps.investigate({ conversationId, focus });
          if (investigation === null) {
            return { status: "busy" as const, suggestion: INVESTIGATION_FALLBACK };
          }
          return { status: "ok" as const, ...investigation };
        } catch (err) {
          // 软降级：调查失败绝不使报告生成失败，主 agent 退回自行翻页。
          log.warn(`investigation of conversation ${conversationId} failed`, err);
          return { status: "failed" as const, suggestion: INVESTIGATION_FALLBACK };
        }
      },
    }),
    readConversation: tool({
      description:
        "Read a bounded page of in-session turns from one listed conversation. Compacted history is returned only as a rolling background summary that may include discussion before this reading; raw messages are strictly after the compaction frontier.",
      inputSchema: z.object({
        conversationId: z.string().min(1),
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).default(20),
      }),
      execute: async ({ conversationId, afterSeq, limit }) =>
        runTool("readConversation", () =>
          readSessionConversation(deps.db, deps.session, conversationId, { afterSeq, limit }),
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
          if (
            !row ||
            row.bookId !== deps.session.bookId ||
            row.id === deps.session.id ||
            row.completedAt === null ||
            row.completedAt > deps.session.startedAt
          ) {
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
