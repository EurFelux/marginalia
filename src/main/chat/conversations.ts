// src/main/chat/conversations.ts
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import type { ConversationDto, CreateConversationInput } from "@shared/chat";

type ConversationRow = typeof conversations.$inferSelect;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    bookId: row.bookId ?? null,
    chapterId: row.chapterId ?? null,
    assistantId: row.assistantId ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 创建会话（chapterId 传 null = 独立会话）；assistantId 取默认 Assistant（按需惰性播种）。 */
export function createConversation(db: DB, input: CreateConversationInput): ConversationDto {
  const assistant = getDefaultAssistant(db);
  const row = db
    .insert(conversations)
    .values({ bookId: input.bookId, chapterId: input.chapterId, assistantId: assistant.id })
    .returning()
    .get();
  return toDto(row);
}

export function getConversation(db: DB, id: string): ConversationDto | null {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return row ? toDto(row) : null;
}

/** 列出某书的会话，最近更新在前。 */
export function listConversationsByBook(db: DB, bookId: string): ConversationDto[] {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.bookId, bookId))
    .orderBy(desc(conversations.updatedAt))
    .all()
    .map(toDto);
}

export interface RouteParams {
  bookId: string;
  currentChapterId: string;
  activeConversationId: string | null;
}

export interface RouteDecision {
  conversationId: string;
  created: boolean;
  switchedFromActive: boolean;
}

/**
 * 划词 → 会话路由（设计文档 §6）。仅指向章节会话；独立会话只经显式入口创建。
 * 有副作用（可能创建会话），故只由 MA5 的 ai.send 内部在确定发送时调用，不接 IPC。
 */
export function routeConversation(db: DB, params: RouteParams): RouteDecision {
  // 仅当存在一个「活的」活动会话、且它不接纳当前划词（绑定别的书/章）时才算「切走」。
  // 陈旧/已删除的 activeConversationId 视作无活动会话，不触发切换提示。
  let switchedFromActive = false;
  if (params.activeConversationId) {
    const active = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, params.activeConversationId))
      .get();
    if (active) {
      // 活动会话同书、且独立或绑定当前章 → 追加
      if (
        active.bookId === params.bookId &&
        (active.chapterId === null || active.chapterId === params.currentChapterId)
      ) {
        return { conversationId: active.id, created: false, switchedFromActive: false };
      }
      switchedFromActive = true;
    }
  }

  const existing = db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.bookId, params.bookId),
        eq(conversations.chapterId, params.currentChapterId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .get();
  if (existing) {
    return { conversationId: existing.id, created: false, switchedFromActive };
  }

  const created = createConversation(db, {
    bookId: params.bookId,
    chapterId: params.currentChapterId,
  });
  return { conversationId: created.id, created: true, switchedFromActive };
}
