import { and, asc, desc, eq, gt, gte, lt, lte, or, type SQLWrapper } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { annotations, bookNotes, conversations, messages } from "@main/db/schema";
import type { ReadingSessionRow } from "@main/reading-sessions/repository";
import { textOfParts } from "@main/ai/prompt";
import type { AnnotationDto, AnnotationStyle } from "@shared/annotations";
import type { BookNoteDto } from "@shared/book-notes";
import type { MessageRole, MessageStatus } from "@shared/types";

export interface SessionConversationSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessageExcerpt {
  id: string;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  seq: number;
  createdAt: number;
}

export const SESSION_CONVERSATION_DEFAULT_LIMIT = 20;
export const SESSION_CONVERSATION_MAX_LIMIT = 50;
export const SESSION_CONVERSATION_TEXT_BUDGET = 24_000;

export interface SessionConversationReadOptions {
  afterSeq?: number;
  limit?: number;
}

export interface SessionConversationMessage extends SessionMessageExcerpt {
  context: "session" | "neighbor";
  truncated: boolean;
}

export type SessionConversationReadResult =
  | {
      status: "compacted-only";
      compactedContext: { summary: string; throughSeq: number };
      messages: [];
    }
  | {
      status: "messages";
      compactedContext: { summary: string; throughSeq: number } | null;
      messages: SessionConversationMessage[];
      hasMore: boolean;
      nextAfterSeq: number | null;
    };

function sessionWindow(session: ReadingSessionRow) {
  if (session.completedAt == null) return null;
  return { startedAt: session.startedAt, completedAt: session.completedAt };
}

function isInWindow(timestamp: SQLWrapper, session: ReadingSessionRow) {
  const window = sessionWindow(session);
  return window && and(gte(timestamp, window.startedAt), lte(timestamp, window.completedAt));
}

function annotationDto(row: typeof annotations.$inferSelect): AnnotationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    style: row.style as AnnotationStyle,
    note: row.note,
    selectedText: row.selectedText,
    locatorRange: row.locatorRange,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bookNoteDto(row: typeof bookNotes.$inferSelect): BookNoteDto {
  return {
    id: row.id,
    bookId: row.bookId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function messageExcerpt(row: typeof messages.$inferSelect): SessionMessageExcerpt {
  return {
    id: row.id,
    role: row.role as MessageRole,
    text: textOfParts(row.parts),
    status: row.status as MessageStatus,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export function listSessionAnnotations(db: DB, session: ReadingSessionRow): AnnotationDto[] {
  const createdInside = isInWindow(annotations.createdAt, session);
  const updatedInside = isInWindow(annotations.updatedAt, session);
  if (!createdInside || !updatedInside) return [];
  return db
    .select()
    .from(annotations)
    .where(and(eq(annotations.bookId, session.bookId), or(createdInside, updatedInside)))
    .orderBy(desc(annotations.createdAt))
    .all()
    .map(annotationDto);
}

export function listSessionBookNotes(db: DB, session: ReadingSessionRow): BookNoteDto[] {
  const createdInside = isInWindow(bookNotes.createdAt, session);
  const updatedInside = isInWindow(bookNotes.updatedAt, session);
  if (!createdInside || !updatedInside) return [];
  return db
    .select()
    .from(bookNotes)
    .where(and(eq(bookNotes.bookId, session.bookId), or(createdInside, updatedInside)))
    .orderBy(desc(bookNotes.createdAt))
    .all()
    .map(bookNoteDto);
}

export function listSessionConversations(
  db: DB,
  session: ReadingSessionRow,
): SessionConversationSummary[] {
  const createdInside = isInWindow(messages.createdAt, session);
  if (!createdInside) return [];
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.bookId, session.bookId), createdInside))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.updatedAt))
    .all();
}

export function readSessionConversation(
  db: DB,
  session: ReadingSessionRow,
  conversationId: string,
  options: SessionConversationReadOptions,
): SessionConversationReadResult {
  const conversation = db
    .select({
      id: conversations.id,
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.bookId, session.bookId)))
    .get();
  if (!conversation) throw new Error("conversation not found for this book");

  const window = sessionWindow(session);
  if (!window) throw new Error("cannot read conversation evidence for an active session");
  const limit = options.limit ?? SESSION_CONVERSATION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_CONVERSATION_MAX_LIMIT) {
    throw new Error(
      `conversation page limit must be between 1 and ${SESSION_CONVERSATION_MAX_LIMIT}`,
    );
  }
  const frontier = conversation.summarizedThroughSeq ?? -1;
  const cursor = Math.max(frontier, options.afterSeq ?? frontier);
  const rawRows = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        gt(messages.seq, frontier),
        gt(messages.seq, cursor),
        gte(messages.createdAt, window.startedAt),
        lte(messages.createdAt, window.completedAt),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit + 1)
    .all();

  if (rawRows.length === 0) {
    const anyInSession = db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          gte(messages.createdAt, window.startedAt),
          lte(messages.createdAt, window.completedAt),
        ),
      )
      .limit(1)
      .get();
    if (
      options.afterSeq === undefined &&
      anyInSession &&
      conversation.summarizedThroughSeq !== null &&
      conversation.contextSummary?.trim()
    ) {
      return {
        status: "compacted-only",
        compactedContext: {
          summary: conversation.contextSummary.trim(),
          throughSeq: conversation.summarizedThroughSeq,
        },
        messages: [],
      };
    }
    if (options.afterSeq !== undefined && anyInSession) {
      return {
        status: "messages",
        compactedContext: null,
        messages: [],
        hasMore: false,
        nextAfterSeq: null,
      };
    }
    throw new Error("conversation has no messages during this reading session");
  }

  const hasMore = rawRows.length > limit;
  const pageRows = rawRows.slice(0, limit);
  const first = pageRows[0]!;
  const last = pageRows.at(-1)!;
  const candidates: Array<{
    row: typeof messages.$inferSelect;
    context: SessionConversationMessage["context"];
  }> = [];
  if (options.afterSeq === undefined) {
    const previous = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          gt(messages.seq, frontier),
          lt(messages.seq, first.seq),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1)
      .get();
    if (previous && textOfParts(previous.parts).length < SESSION_CONVERSATION_TEXT_BUDGET) {
      candidates.push({ row: previous, context: "neighbor" });
    }
  }
  candidates.push(...pageRows.map((row) => ({ row, context: "session" as const })));
  if (!hasMore) {
    const next = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          gt(messages.seq, frontier),
          gt(messages.seq, last.seq),
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(1)
      .get();
    if (next) candidates.push({ row: next, context: "neighbor" });
  }

  let remaining = SESSION_CONVERSATION_TEXT_BUDGET;
  const excerpts: SessionConversationMessage[] = [];
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const excerpt = messageExcerpt(candidate.row);
    const truncated = excerpt.text.length > remaining;
    const text = truncated ? excerpt.text.slice(0, remaining) : excerpt.text;
    excerpts.push({ ...excerpt, text, context: candidate.context, truncated });
    remaining -= text.length;
  }
  const summary = conversation.contextSummary?.trim();
  const compactedContext =
    options.afterSeq === undefined && summary && conversation.summarizedThroughSeq !== null
      ? { summary, throughSeq: conversation.summarizedThroughSeq }
      : null;
  const lastReturnedSessionSeq = excerpts
    .filter((excerpt) => excerpt.context === "session")
    .at(-1)?.seq;
  const budgetOmittedRows =
    lastReturnedSessionSeq !== undefined && lastReturnedSessionSeq < last.seq;
  const pageHasMore = hasMore || budgetOmittedRows;
  return {
    status: "messages",
    compactedContext,
    messages: excerpts,
    hasMore: pageHasMore,
    nextAfterSeq: pageHasMore ? (lastReturnedSessionSeq ?? cursor) : null,
  };
}

export function hasReaderEvidence(db: DB, session: ReadingSessionRow): boolean {
  const annotationCreatedInside = isInWindow(annotations.createdAt, session);
  const annotationUpdatedInside = isInWindow(annotations.updatedAt, session);
  if (!annotationCreatedInside || !annotationUpdatedInside) return false;
  if (
    db
      .select({ id: annotations.id })
      .from(annotations)
      .where(
        and(
          eq(annotations.bookId, session.bookId),
          or(annotationCreatedInside, annotationUpdatedInside),
        ),
      )
      .limit(1)
      .get()
  ) {
    return true;
  }

  const noteCreatedInside = isInWindow(bookNotes.createdAt, session);
  const noteUpdatedInside = isInWindow(bookNotes.updatedAt, session);
  if (
    db
      .select({ id: bookNotes.id })
      .from(bookNotes)
      .where(and(eq(bookNotes.bookId, session.bookId), or(noteCreatedInside!, noteUpdatedInside!)))
      .limit(1)
      .get()
  ) {
    return true;
  }

  const messageCreatedInside = isInWindow(messages.createdAt, session);
  return Boolean(
    messageCreatedInside &&
    db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.bookId, session.bookId), messageCreatedInside))
      .limit(1)
      .get(),
  );
}
