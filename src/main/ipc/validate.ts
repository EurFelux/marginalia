import type { z } from "zod";

/** 校验 IPC 入参；非法即抛出带通道名的错误。 */
export function validateInput<T>(channel: string, schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`IPC ${channel} invalid input: ${parsed.error.message}`);
  }
  return parsed.data;
}
