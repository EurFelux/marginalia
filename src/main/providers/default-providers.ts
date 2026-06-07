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
    // DeepSeek 同时兼容 OpenAI Chat Completions 与 Anthropic（两端点不同）：默认 chat-completions；
    // baseUrl 不入 db（保持 null），由 provider-factory / resolveProviderBaseUrl 按 type 派生。
    type: "openai-chat-completions",
    compatibleApis: ["openai-chat-completions", "anthropic"],
    label: "DeepSeek",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
];

/**
 * 启动时补齐缺失的内置 provider：对每条 DEFAULT_PROVIDERS，若不存在「同 label 的内置 provider」则插入
 * （isBuiltin=true、无 key/baseUrl、预填 models）。已存在则不动（保留用户填的 key / 改的 models）。
 * 用户自建的同名非内置 provider 不算数（只认 isBuiltin=1），故加 config 新项即自动出现，且不与用户数据冲突。
 */
export function ensureBuiltinProviders(db: DB): void {
  const inserted: string[] = [];
  for (const p of DEFAULT_PROVIDERS) {
    const exists = db
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.isBuiltin, true), eq(providers.label, p.label)))
      .limit(1)
      .all();
    if (exists.length > 0) continue;
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
}
