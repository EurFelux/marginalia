import { and, asc, desc, eq, gte, lte, or, type SQLWrapper } from "drizzle-orm";
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
): SessionMessageExcerpt[] {
  const conversation = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.bookId, session.bookId)))
    .get();
  if (!conversation) throw new Error("conversation not found for this book");

  const createdInside = isInWindow(messages.createdAt, session);
  if (!createdInside) return [];
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.seq))
    .all();
  const inWindowIndexes = rows.flatMap((row, index) => {
    const window = sessionWindow(session);
    return window && row.createdAt >= window.startedAt && row.createdAt <= window.completedAt
      ? [index]
      : [];
  });
  if (inWindowIndexes.length === 0) {
    throw new Error("conversation has no messages during this reading session");
  }

  const first = inWindowIndexes[0]!;
  const last = inWindowIndexes.at(-1)!;
  const excerptIndexes = new Set(inWindowIndexes);
  if (first > 0) excerptIndexes.add(first - 1);
  if (last < rows.length - 1) excerptIndexes.add(last + 1);
  return [...excerptIndexes].sort((a, b) => a - b).map((index) => messageExcerpt(rows[index]!));
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
