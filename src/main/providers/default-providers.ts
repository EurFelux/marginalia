import type { DB } from "@main/db/client";
import { providers } from "@main/db/schema";
import type { ProviderType } from "@shared/providers";

/** 初始态预置的默认 provider（不含 openai-compatible——用户手动加）。models 为预填常用起始型号；
 *  baseUrl=null（用各 type 默认端点）、无 apiKey。型号可被用户编辑/拉取覆盖。配置单独存放、单一源。 */
export const DEFAULT_PROVIDERS: { type: ProviderType; label: string; models: string[] }[] = [
  { type: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  {
    type: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  { type: "google", label: "Gemini", models: ["gemini-1.5-flash", "gemini-1.5-pro"] },
];

/** 空列表就播种：providers 表为空时插入默认；非空则 no-op（不重复、不扰现有）。 */
export function seedDefaultProviders(db: DB): void {
  const existing = db.select({ id: providers.id }).from(providers).limit(1).all();
  if (existing.length > 0) return;
  for (const p of DEFAULT_PROVIDERS) {
    db.insert(providers).values({ type: p.type, label: p.label, models: p.models }).run();
  }
}
