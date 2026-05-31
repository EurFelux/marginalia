// src/shared/chat.ts
import { z } from "zod";
import type { UIMessage } from "ai";
import type { MessageMetadata } from "@shared/types";

/** 上下文 chip（live 形态，供 renderer 渲染；持久化快照只取 {id,content,tokenCount}，见 messageMetadataSchema） */
export const chipSchema = z.object({
  id: z.enum(["selection", "paragraph"]),
  labelKey: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
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

export interface ConversationDto {
  id: string;
  bookId: string | null;
  chapterId: string | null;
  assistantId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  metadata: MessageMetadata | null;
  seq: number;
  createdAt: number;
}
