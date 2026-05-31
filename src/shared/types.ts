import { z } from "zod";
import type { TocNode } from "@marginalia/epub-parser";

export type { TocNode };

/** 上下文 chip 的 id 枚举（live Chip 与持久化 contextChips 共用，单一来源避免漂移） */
export const chipIdSchema = z.enum(["selection", "paragraph"]);

/** 消息角色联合（主-渲染跨层共享，避免 ×4 重复声明） */
export type MessageRole = "system" | "user" | "assistant";

/** DB JSON 列 parse-on-read 用 */
export const tocNodeSchema: z.ZodType<TocNode> = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    children: z.array(tocNodeSchema).optional(),
  }),
);

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
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
