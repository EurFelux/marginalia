import { z } from "zod";
import type { TocNode } from "@marginalia/epub-parser";

export type { TocNode };

/** 上下文 chip 的 id 枚举（live Chip 与持久化 contextChips 共用，单一来源避免漂移） */
export const chipIdSchema = z.enum(["selection", "paragraph", "chapter-summary", "book-summary"]);

/** 消息角色联合（主-渲染跨层共享，避免 ×4 重复声明） */
export type MessageRole = "system" | "user" | "assistant";

/** 一轮 AI 对话的终态（仅 assistant 行可能非 complete；写一次不再改，见 DB lifecycle spec §3）。 */
export type MessageStatus = "complete" | "error" | "aborted";

/** DB JSON 列 parse-on-read 用 */
export const tocNodeSchema: z.ZodType<TocNode> = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    anchor: z.string().optional(),
    children: z.array(tocNodeSchema).optional(),
  }),
);

const tokenCount = z.number().int().nonnegative();

/**
 * 一轮 assistant 回复的 token 用量（spec 2026-10-11 message-usage-display §4.1）。
 * 输入/输出为已完成各步之和（计费口径）；拆分项只在 provider 报了时存在。
 */
export const messageUsageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  noCacheTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
  /** 已完成的步数（本功能上线前的旧消息没有）。 */
  stepCount: tokenCount.optional(),
  /** 最后一个已完成步骤的输入，即当时上下文的大小。 */
  lastStepInputTokens: tokenCount.optional(),
});

export type MessageUsage = z.infer<typeof messageUsageSchema>;

/** 消息附带的 app 元数据（存入 UIMessage.metadata） */
export const messageMetadataSchema = z.object({
  contextChips: z
    .array(
      z.object({
        id: chipIdSchema,
        content: z.string(),
        tokenCount: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  model: z.string().optional(),
  usage: messageUsageSchema.optional(),
  // error 终态的原因（透传 provider 真实 name/message；不编造、不分类——结构化 reason 是 ma5-deferred #6）。
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  // 需向用户反馈的异常 finish reason（length / content-filter / error）；仅在有反馈时写入。
  finish: z
    .object({
      reason: z.string(),
      raw: z.string().optional(),
    })
    .optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
