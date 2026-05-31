import type { z } from "zod";

/** 校验 IPC 入参；非法即抛出带通道名 + 可读详情的错误。 */
export function validateInput<T>(channel: string, schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(`IPC ${channel} invalid input: ${detail}`);
  }
  return parsed.data;
}
