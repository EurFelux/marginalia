import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { providers } from "@main/db/schema";
import type { ProviderType } from "@shared/providers";

/** 内置默认 provider 的单一源（不含 openai-compatible——用户手动加）。models 为预填常用起始型号；
 *  baseUrl=null（用各 type 默认端点）、无 apiKey。**以 label 作内置身份**（label 内置不可改）。
 *  往此数组加一条 → 下次启动 `ensureBuiltinProviders` 自动补齐。 */
export const DEFAULT_PROVIDERS: { type: ProviderType; label: string; models: string[] }[] = [
  { type: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  {
    type: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  { type: "google", label: "Gemini", models: ["gemini-1.5-flash", "gemini-1.5-pro"] },
];

/**
 * 启动时补齐缺失的内置 provider：对每条 DEFAULT_PROVIDERS，若不存在「同 label 的内置 provider」则插入
 * （isBuiltin=true、无 key/baseUrl、预填 models）。已存在则不动（保留用户填的 key / 改的 models）。
 * 用户自建的同名非内置 provider 不算数（只认 isBuiltin=1），故加 config 新项即自动出现，且不与用户数据冲突。
 */
export function ensureBuiltinProviders(db: DB): void {
  for (const p of DEFAULT_PROVIDERS) {
    const exists = db
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.isBuiltin, true), eq(providers.label, p.label)))
      .limit(1)
      .all();
    if (exists.length > 0) continue;
    db.insert(providers)
      .values({ type: p.type, label: p.label, models: p.models, isBuiltin: true })
      .run();
  }
}
