// src/main/ai/structured-output.ts —— 从模型自由文本里健壮地抽取并校验 JSON 输出。
// 不用 generateObject/response_format——OpenAI 兼容 provider 对 json_object 支持参差、tool 模式亦不可靠；
// 自己解析对任何文本模型都通用，且解析逻辑可单测。memory-consolidation 与 reading-report 的 subagent 共用。
import type { z } from "zod";

/** 剥 markdown 代码围栏并扫出最外层平衡的 {…}（容忍模型在 JSON 前后夹带 prose）；找不到返回 null。 */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return null;
}

/**
 * 剥围栏 → 平衡括号扫出最外层对象 → JSON.parse → Zod 校验。
 * 任何一步失败返回 null（调用方自行决定跳过、重试还是降级）。
 */
export function parseJsonOutput<T extends z.ZodType>(text: string, schema: T): z.infer<T> | null {
  const json = extractJsonObject(text);
  if (json == null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
