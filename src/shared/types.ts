import { z } from "zod";
import type { TocNode } from "@marginalia/epub-parser";

export type { TocNode };

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
        id: z.enum(["selection", "paragraph"]),
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
