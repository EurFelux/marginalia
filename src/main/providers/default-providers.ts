import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { providers } from "@main/db/schema";
import type { AiProviderApiType } from "@shared/providers";
import { createLogger } from "@main/logger";

const log = createLogger("providers");

interface DefaultProvider {
  type: AiProviderApiType;
  /** 兼容的 API 格式；length>1 才允许切 type（如 DeepSeek 兼容 chat-completions + anthropic）。 */
  compatibleApis: AiProviderApiType[];
  label: string;
  models: string[];
}

/** 内置默认 provider 的单一源。models 为预填常用起始型号；baseUrl=null（OpenAI/Anthropic/Gemini 用各 type
 *  默认端点；DeepSeek 两 API 端点不同，由 provider-factory 按 type 派生）、无 apiKey。
 *  **以 label 作内置身份**（label 内置不可改）。往此数组加一条 → 下次启动 `ensureBuiltinProviders` 自动补齐。 */
export const DEFAULT_PROVIDERS: DefaultProvider[] = [
  {
    type: "openai-responses",
    compatibleApis: ["openai-responses"],
    label: "OpenAI",
    models: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    type: "anthropic",
    compatibleApis: ["anthropic"],
    label: "Anthropic",
    models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    type: "google-generate-content",
    compatibleApis: ["google-generate-content"],
    label: "Gemini",
    models: ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview"],
  },
  {
    // DeepSeek 兼容 OpenAI Chat Completions / OpenAI Responses / Anthropic 三套协议（同 host，
    // 端点不同）：默认 chat-completions；baseUrl 不入 db（保持 null），由 provider-factory /
    // resolveProviderBaseUrl 按 type 派生。
    type: "openai-chat-completions",
    compatibleApis: ["openai-chat-completions", "openai-responses", "anthropic"],
    label: "DeepSeek",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
];

/**
 * 启动时补齐缺失的内置 provider：对每条 DEFAULT_PROVIDERS，若不存在「同 label 的内置 provider」则插入
 * （isBuiltin=true、无 key/baseUrl、预填 models）。已存在则仅**补齐 compatibleApis 缺项**（如 DeepSeek
 * 后来支持 Responses API——既有行加上新选项，用户已选 type / key / models 一律不动）。
 * 用户自建的同名非内置 provider 不算数（只认 isBuiltin=1），故加 config 新项即自动出现，且不与用户数据冲突。
 */
export function ensureBuiltinProviders(db: DB): void {
  const inserted: string[] = [];
  const upgraded: string[] = [];
  for (const p of DEFAULT_PROVIDERS) {
    const existing = db
      .select({ id: providers.id, compatibleApis: providers.compatibleApis })
      .from(providers)
      .where(and(eq(providers.isBuiltin, true), eq(providers.label, p.label)))
      .limit(1)
      .all();
    if (existing.length > 0) {
      const row = existing[0];
      const current = row.compatibleApis ?? [];
      if (p.compatibleApis.some((api) => !current.includes(api))) {
        db.update(providers)
          .set({ compatibleApis: p.compatibleApis })
          .where(eq(providers.id, row.id))
          .run();
        upgraded.push(p.label);
      }
      continue;
    }
    db.insert(providers)
      .values({
        type: p.type,
        compatibleApis: p.compatibleApis,
        label: p.label,
        models: p.models,
        isBuiltin: true,
      })
      .run();
    inserted.push(p.label);
  }
  if (inserted.length > 0) {
    log.info(`ensured builtin providers: ${inserted.join(", ")}`);
  }
  if (upgraded.length > 0) {
    log.info(`upgraded builtin provider compatibleApis: ${upgraded.join(", ")}`);
  }
}
