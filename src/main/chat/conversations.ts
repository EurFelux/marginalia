// src/main/chat/conversations.ts
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import { isNamingConversation } from "@main/chat/conversation-title";
import type { ConversationDto, CreateConversationInput } from "@shared/chat";
import { dropAgentContext } from "@main/ai/agent-context";

type ConversationRow = typeof conversations.$inferSelect;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    title: row.title ?? null,
    isNaming: isNamingConversation(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 创建会话（绑定到书；单一全局 agent，无 assistant 概念）。
 * 防堆积（spec §5）：该书已存在零消息会话 → 返回最新的那个而不新建。
 */
export function createConversation(db: DB, input: CreateConversationInput): ConversationDto {
  const empty = db
    .select({ row: conversations })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.bookId, input.bookId), isNull(messages.id)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  if (empty) return toDto(empty.row);

  const row = db.insert(conversations).values({ bookId: input.bookId }).returning().get();
  return toDto(row);
}

export function getConversation(db: DB, id: string): ConversationDto | null {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return row ? toDto(row) : null;
}

/** 设置会话标题（auto naming 写回；未来手动命名复用）。 */
export function setConversationTitle(db: DB, id: string, title: string): void {
  db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
}

/** 删除会话（messages 由 FK 级联删）；幂等——未知 id 为 0-row delete。 */
export function deleteConversation(db: DB, id: string): void {
  db.delete(conversations).where(eq(conversations.id, id)).run();
  dropAgentContext(id);
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
