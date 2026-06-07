// src/shared/chat.ts
import { z } from "zod";
import type { UIMessage, UIMessageChunk } from "ai";
import { chipIdSchema } from "@shared/types";
import type { MessageMetadata, MessageRole, MessageStatus } from "@shared/types";

/** 上下文 chip（live 形态，供 renderer 渲染；持久化快照只取 {id,content,tokenCount}，见 messageMetadataSchema） */
export const chipSchema = z.object({
  id: chipIdSchema,
  labelKey: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /**
   * 三态闭合联合：required=历史水合产出（落库即已发送、不可交互）；
   * on/off=live 态（摘要 toggle 开关；选区/段落构建为 on、UI 可整体删除）。
   * off 的 chip 发送前由 renderer 过滤。
   */
  state: z.enum(["required", "on", "off"]),
});
export type Chip = z.infer<typeof chipSchema>;

/** ai:build-chips 入参——renderer 提取的选区原句 + 前1/当前/后1 段原始文本 */
export const buildChipsInput = z.object({
  selection: z.string().min(1),
  paragraphBefore: z.string().nullish(),
  paragraphCurrent: z.string(),
  paragraphAfter: z.string().nullish(),
});
export type BuildChipsInput = z.infer<typeof buildChipsInput>;

export const readingContextSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("pdf"),
    page: z.number().int().min(1),
    pageCount: z.number().int().min(1).nullable().optional(),
    chapterId: z.string().min(1).nullable().optional(),
    chapterTitle: z.string().min(1).nullable().optional(),
  }),
  z.object({
    format: z.literal("epub"),
    chapterId: z.string().min(1),
    chapterTitle: z.string().min(1).nullable().optional(),
    offset: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().positive().optional(),
    spineIndex: z.number().int().nonnegative().optional(),
    locator: z.string().min(1).nullable().optional(),
  }),
]);
export type ReadingContext = z.infer<typeof readingContextSchema>;

/** conversations:create 入参。 */
export const createConversationInput = z.object({
  bookId: z.string().min(1),
});
export type CreateConversationInput = z.infer<typeof createConversationInput>;

/** conversations:get 入参 */
export const conversationIdInput = z.object({ id: z.string().min(1) });
export type ConversationIdInput = z.infer<typeof conversationIdInput>;

/** messages:list-by-conversation 入参 */
export const messagesByConversationInput = z.object({ conversationId: z.string().min(1) });
export type MessagesByConversationInput = z.infer<typeof messagesByConversationInput>;

/** 会话视图。bookId/assistantId 恒非空（列已 NOT NULL）；isNaming 为主进程内存瞬态合成（spec §5）。 */
export interface ConversationDto {
  id: string;
  bookId: string;
  assistantId: string;
  title: string | null;
  /** auto naming 进行中（下一任务接线真状态前恒 false）。 */
  isNaming: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: UIMessage["parts"];
  metadata: MessageMetadata | null;
  status: MessageStatus;
  seq: number;
  createdAt: number;
}

/** runSend 的业务入参（不含传输层 streamId）。conversationId 必传：send 只校验不分配（spec §5）。 */
export const sendInputSchema = z.object({
  bookId: z.string().min(1),
  conversationId: z.string().min(1),
  chips: z.array(chipSchema),
  userText: z.string().min(1),
  readingContext: readingContextSchema.nullish(),
});
export type SendInput = z.infer<typeof sendInputSchema>;

/** ai:send 入站载体 = 业务入参 + 渲染层铸的 streamId。 */
export const sendRequest = sendInputSchema.extend({ streamId: z.string().min(1) });
export type SendRequest = z.infer<typeof sendRequest>;

/** ai:send invoke 的同步 ack（增量走 ai:chunk 事件流，故不含 stream/finished）。 */
export const sendAck = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), conversationId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SendAck = z.infer<typeof sendAck>;

/** ai:abort 入参。 */
export const abortInput = z.object({ streamId: z.string().min(1) });
export type AbortInput = z.infer<typeof abortInput>;

/** ai:chunk 出站事件（main→renderer，不 Zod；UIMessageChunk 为 AI SDK 复杂联合）。 */
export type AiStreamEvent =
  | { streamId: string; type: "chunk"; chunk: UIMessageChunk }
  | { streamId: string; type: "finish" }
  | { streamId: string; type: "error"; message: string };
