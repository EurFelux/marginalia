// src/main/chat/conversations.ts
import { desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import type { ConversationDto, CreateConversationInput } from "@shared/chat";

type ConversationRow = typeof conversations.$inferSelect;

function toDto(row: ConversationRow): ConversationDto {
  const base = {
    id: row.id,
    bookId: row.bookId,
    assistantId: row.assistantId,
    title: row.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.chapterId === null
    ? { ...base, kind: "independent", chapterId: null }
    : { ...base, kind: "chapter", chapterId: row.chapterId };
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

/** 设置会话标题（首建会话落「随便起」标题 / 未来自动命名覆盖）。 */
export function setConversationTitle(db: DB, id: string, title: string): void {
  db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
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
 * send 时会话路由。有副作用（可能创建会话），故只由 ai.send 内部在确定发送时调用，不接 IPC。
 * 仅当存在「活的」同书 active 会话、且其为独立或绑定当前章时才追加；
 * 其余情况（不同章 / 陈旧 / 无 active）一律建新——「回来继续本章会话」由会话 tab 显式重开取代，
 * 故弃 find-or-create：会话只在 send 时创建，「新对话」后提问真·新会话。
 */
export function routeConversation(db: DB, params: RouteParams): RouteDecision {
  // 仅当存在「活的」同书 active 会话、且其为独立或绑定当前章时才追加；
  // 其余情况（不同章 / 陈旧 / 无 active）一律建新——「回来继续本章会话」由会话 tab 显式重开取代，
  // 故弃 find-or-create：会话只在 send 时创建，「新对话」后提问真·新会话。
  if (params.activeConversationId) {
    const active = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, params.activeConversationId))
      .get();
    if (active && active.bookId === params.bookId) {
      if (active.chapterId === null || active.chapterId === params.currentChapterId) {
        return { conversationId: active.id, created: false, switchedFromActive: false };
      }
      // 不同章：离开 active 建新（防御兜底——正常路径渲染层已在划词时清 active）
      const created = createConversation(db, {
        bookId: params.bookId,
        chapterId: params.currentChapterId,
      });
      return { conversationId: created.id, created: true, switchedFromActive: true };
    }
  }
  const created = createConversation(db, {
    bookId: params.bookId,
    chapterId: params.currentChapterId,
  });
  return { conversationId: created.id, created: true, switchedFromActive: false };
}
