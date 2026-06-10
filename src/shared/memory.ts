import { z } from "zod";

/** AI 侧统一标识符：英文 kebab-case 短名（spec 2026-06-10 §2.1）。 */
export const memorySlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case slug expected");

/** 管理面板用的记忆视图（含来源书名投影）。 */
export interface MemoryDto {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  sourceBookId: string | null;
  sourceBookTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

/** memories:update 入参（管理面板按 id 操作；slug 不可改）。 */
export const updateMemoryInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});
export type UpdateMemoryInput = z.infer<typeof updateMemoryInput>;

/** memories:delete 入参。 */
export const deleteMemoryInput = z.object({ id: z.string().min(1) });
export type DeleteMemoryInput = z.infer<typeof deleteMemoryInput>;
