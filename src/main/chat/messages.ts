// src/main/chat/messages.ts
import { and, asc, desc, eq, gt, lt, max } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import type { MessageDto } from "@shared/chat";
import { createLogger } from "@main/logger";

const log = createLogger("chat");
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
  log.warn("invalid metadata json; degrading to null", parsed.error.message);
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

/** 分页列出会话内消息：beforeSeq 指定时返回 seq < beforeSeq 的较早一页；
 *  limit 指定时多拿一条探测 hasMore。 */
export function listMessagesPaginated(
  db: DB,
  conversationId: string,
  beforeSeq?: number,
  limit?: number,
): { messages: MessageDto[]; hasMore: boolean } {
  const where =
    beforeSeq != null
      ? and(eq(messages.conversationId, conversationId), lt(messages.seq, beforeSeq))
      : eq(messages.conversationId, conversationId);
  const query = db.select().from(messages).where(where).orderBy(desc(messages.seq));
  const rows = limit != null ? query.limit(limit + 1).all() : query.all();
  const hasMore = limit != null && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page.reverse().map(toDto), hasMore };
}

/** 列出 seq > afterSeq 的尾轮（升序）；afterSeq 为 null 取全量（等价 listMessages）。 */
export function listMessagesAfterSeq(
  db: DB,
  conversationId: string,
  afterSeq: number | null,
): MessageDto[] {
  const where =
    afterSeq == null
      ? eq(messages.conversationId, conversationId)
      : and(eq(messages.conversationId, conversationId), gt(messages.seq, afterSeq));
  return db.select().from(messages).where(where).orderBy(asc(messages.seq)).all().map(toDto);
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

/** 取单条消息 dto；无则 null。 */
export function getMessage(db: DB, messageId: string): MessageDto | null {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get();
  return row ? toDto(row) : null;
}

/**
 * 重置 user 轮以重发（事务）：① 设该 user 消息 parts=[{text}]（保留 metadata 快照）；
 * ② 删 seq > 其 seq 的全部消息；③ 若 summarizedThroughSeq >= 其 seq，重置滚动摘要
 * （contextSummary=null, summarizedThroughSeq=null，否则摘要引用已删消息）；④ 推进 updatedAt。
 * 返回该 user 消息 seq。调用方须已校验 messageId 为本会话 user 消息。
 */
export function resetUserTurnForResend(
  db: DB,
  conversationId: string,
  messageId: string,
  text: string,
): number {
  return db.transaction((tx) => {
    const row = tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .get();
    if (!row) throw new Error("message not found in conversation");
    const seq = row.seq;
    tx.update(messages)
      .set({ parts: [{ type: "text", text }] })
      .where(eq(messages.id, messageId))
      .run();
    tx.delete(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, seq)))
      .run();
    const convo = tx
      .select({ s: conversations.summarizedThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    const resetSummary = convo?.s != null && convo.s >= seq;
    tx.update(conversations)
      .set({
        updatedAt: Date.now(),
        ...(resetSummary ? { contextSummary: null, summarizedThroughSeq: null } : {}),
      })
      .where(eq(conversations.id, conversationId))
      .run();
    return seq;
  });
}

/**
 * 崩溃恢复派生（DD-§3.1）：会话尾消息是 user 行（其后无 assistant）即「未获回复的未完成轮」。
 * 进程硬崩溃流到一半时不落 assistant，故只靠此读时派生识别——无需持久化任何运行态。
 */
export function isLastTurnIncomplete(db: DB, conversationId: string): boolean {
  const last = db
    .select({ role: messages.role })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(1)
    .get();
  return last?.role === "user";
}
