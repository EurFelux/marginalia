// src/main/chat/messages.ts
import { asc, desc, eq, max } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import type { MessageDto } from "@shared/chat";
import {
  messageMetadataSchema,
  type MessageMetadata,
  type MessageRole,
  type MessageStatus,
} from "@shared/types";

type MessageRow = typeof messages.$inferSelect;

/** DB JSON 列 parse-on-read：metadata 形状漂移（旧数据/外部写入）时记录并降级为 null，而非靠 ?. 静默吸收。 */
function parseMetadata(raw: MessageRow["metadata"]): MessageMetadata | null {
  if (raw == null) return null;
  const parsed = messageMetadataSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[messages] invalid metadata json; degrading to null:", parsed.error.message);
  return null;
}

function toDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    parts: row.parts,
    metadata: parseMetadata(row.metadata),
    status: row.status,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  parts: UIMessage["parts"];
  metadata?: MessageMetadata | null;
  /** 终态；省略默认 complete（user/system 行恒 complete）。 */
  status?: MessageStatus;
}

/** 追加一条消息：事务内取下一 seq、插入、并推进 conversations.updatedAt。 */
export function appendMessage(db: DB, input: AppendMessageInput): MessageDto {
  return db.transaction((tx) => {
    const top = tx
      .select({ m: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .get();
    // 空会话起始 seq = 0（max 不存在时 -1 + 1）
    const nextSeq = (top?.m ?? -1) + 1;

    const inserted = tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        parts: input.parts,
        metadata: input.metadata ?? null,
        status: input.status ?? "complete",
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
    const meta = parseMetadata(r.metadata);
    const para = meta?.contextChips?.find((c) => c.id === "paragraph");
    if (para) return para.content;
  }
  return null;
}
