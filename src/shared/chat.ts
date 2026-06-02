// src/shared/chat.ts
import { z } from "zod";
import type { UIMessage, UIMessageChunk } from "ai";
import { chipIdSchema } from "@shared/types";
import type { MessageMetadata, MessageRole } from "@shared/types";

/** 上下文 chip（live 形态，供 renderer 渲染；持久化快照只取 {id,content,tokenCount}，见 messageMetadataSchema） */
export const chipSchema = z.object({
  id: chipIdSchema,
  labelKey: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  // TODO(MA5): required/enabled 当前无读取方；UI toggle 落地时收敛为闭合联合（参见 ProviderDto 三态 follow-up）
  required: z.boolean(),
  enabled: z.boolean(),
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

/** conversations:create 入参——chapterId 传 null 表示显式「独立会话」 */
export const createConversationInput = z.object({
  bookId: z.string().min(1),
  chapterId: z.string().min(1).nullable(),
});
export type CreateConversationInput = z.infer<typeof createConversationInput>;

/** conversations:get 入参 */
export const conversationIdInput = z.object({ id: z.string().min(1) });
export type ConversationIdInput = z.infer<typeof conversationIdInput>;

/** messages:list-by-conversation 入参 */
export const messagesByConversationInput = z.object({ conversationId: z.string().min(1) });
export type MessagesByConversationInput = z.infer<typeof messagesByConversationInput>;

interface ConversationBase {
  id: string;
  bookId: string;
  assistantId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 会话视图，按 chapterId 存在性判别（非法组合不可表示）：
 *  - `chapter`：绑定具体章节（chapterId 非空）。
 *  - `independent`：独立会话（chapterId 为 null）。
 * bookId/assistantId 恒非空（列已 NOT NULL）。
 */
export type ConversationDto =
  | (ConversationBase & { kind: "chapter"; chapterId: string })
  | (ConversationBase & { kind: "independent"; chapterId: null });

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: UIMessage["parts"];
  metadata: MessageMetadata | null;
  seq: number;
  createdAt: number;
}

/** runSend 的业务入参（不含传输层 streamId）。取代 send.ts 中手写的 SendInput interface。 */
export const sendInputSchema = z.object({
  bookId: z.string().min(1),
  currentChapterId: z.string().min(1),
  activeConversationId: z.string().min(1).nullable(),
  chips: z.array(chipSchema),
  userText: z.string().min(1),
});
export type SendInput = z.infer<typeof sendInputSchema>;

/** ai:send 入站载体 = 业务入参 + 渲染层铸的 streamId。 */
export const sendRequest = sendInputSchema.extend({ streamId: z.string().min(1) });
export type SendRequest = z.infer<typeof sendRequest>;

/** ai:send invoke 的同步 ack（增量走 ai:chunk 事件流，故不含 stream/finished）。 */
export const sendAck = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    conversationId: z.string(),
    created: z.boolean(),
    switchedFromActive: z.boolean(),
  }),
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
