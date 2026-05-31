// src/main/chat/messages.ts
import { asc, desc, eq, max } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import type { MessageDto } from "@shared/chat";
import type { MessageMetadata } from "@shared/types";

type MessageRow = typeof messages.$inferSelect;

function toDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    parts: row.parts,
    metadata: row.metadata ?? null,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export interface AppendMessageInput {
  conversationId: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  metadata?: MessageMetadata | null;
}

/** 追加一条消息：事务内取下一 seq、插入、并推进 conversations.updatedAt。 */
export function appendMessage(db: DB, input: AppendMessageInput): MessageDto {
  return db.transaction((tx) => {
    const top = tx
      .select({ m: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .get();
    const nextSeq = (top?.m ?? -1) + 1;

    const inserted = tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        parts: input.parts,
        metadata: input.metadata ?? null,
        seq: nextSeq,
      })
      .returning()
      .get();

    tx.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, input.conversationId))
      .run();

    return toDto(inserted);
  });
}

/** 按 seq 升序列出会话内全部消息。 */
export function listMessages(db: DB, conversationId: string): MessageDto[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all()
    .map(toDto);
}

/** 倒序找最近一条带段落 chip 的 user 消息，返回其段落内容（设计文档 §6「上一次插入的」）；无则 null。 */
export function getLastParagraphContent(db: DB, conversationId: string): string | null {
  const rows = db
    .select({ role: messages.role, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .all();
  for (const r of rows) {
    if (r.role !== "user") continue;
    const para = r.metadata?.contextChips?.find((c) => c.id === "paragraph");
    if (para) return para.content;
  }
  return null;
}
