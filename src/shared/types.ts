import { z } from "zod";

/** ePub 目录树节点（books.toc 的元素） */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

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
