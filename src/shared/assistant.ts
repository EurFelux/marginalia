import { z } from "zod";

/** 更新默认 Assistant 的可编辑字段（仅传入的字段被更新；providerId 传 null 表示解绑）。 */
export const updateAssistantInput = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().nullish(),
  providerId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
});
export type UpdateAssistantInput = z.infer<typeof updateAssistantInput>;

export interface AssistantDto {
  id: string;
  name: string;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
}
