import { z } from "zod";

/**
 * AI provider 的 **API 端点格式**（按实际协议区分，非公司名）。一个 provider 可兼容多种（compatibleApis）。
 * `google-interactions`（Google 新 Interactions API）尚 beta，待 GA 再加。
 */
export const aiProviderApiType = z.enum([
  "openai-responses",
  "openai-chat-completions",
  "anthropic",
  "google-generate-content",
]);
export type AiProviderApiType = z.infer<typeof aiProviderApiType>;

/** 各 API type 官方默认端点：UI baseUrl 占位符 + 拉模型兜底共用（不注入生成路径——那交 SDK 自带默认）。 */
export const DEFAULT_BASE_URL: Record<AiProviderApiType, string | null> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-chat-completions": null, // 兼容端点无默认（自建网关，必填）
  anthropic: "https://api.anthropic.com/v1",
  "google-generate-content": "https://generativelanguage.googleapis.com/v1beta",
};

/** API type 的 UI 显示名。 */
export const PROVIDER_TYPE_LABEL: Record<AiProviderApiType, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat-completions": "OpenAI Chat Completions",
  anthropic: "Anthropic",
  "google-generate-content": "Gemini",
};

/**
 * 内置 DeepSeek 的 per-type baseUrl —— DeepSeek 同时兼容 OpenAI Chat Completions 与 Anthropic，
 * 但两套 API 端点不同；其 `db.baseUrl` 存 null，按当前 type 派生（见 {@link resolveProviderBaseUrl}）。
 */
const DEEPSEEK_BASE_URL: Partial<Record<AiProviderApiType, string>> = {
  "openai-chat-completions": "https://api.deepseek.com",
  anthropic: "https://api.deepseek.com/anthropic",
};

/** 是否为内置 DeepSeek provider（其 baseUrl 在 db 为 null、需按 type 派生，故下游须特判）。 */
export function isDeepseekProvider(p: { label: string | null; isBuiltin: boolean }): boolean {
  return p.isBuiltin && p.label === "DeepSeek";
}

/**
 * provider 在某 type 下实际生效的 baseUrl（纯逻辑单一源，main 工厂与 renderer 表单共用）：
 *  - 内置 DeepSeek：`db.baseUrl=null`，按 type 派生（chat-completions / anthropic 端点不同）；
 *  - 其它：直接用存储的 baseUrl（null = 用 type 默认端点 / SDK 默认）。
 */
export function resolveProviderBaseUrl(
  p: { label: string | null; isBuiltin: boolean; baseUrl: string | null },
  type: AiProviderApiType,
): string | null {
  if (isDeepseekProvider(p)) return DEEPSEEK_BASE_URL[type] ?? null;
  return p.baseUrl;
}

/** 只含一个 provider id 的入参（reveal / remove 共用）。 */
export const providerIdInput = z.object({ id: z.string().min(1) });
export type ProviderIdInput = z.infer<typeof providerIdInput>;

/** 测试连接入参：provider id + 要测试的模型名（生成端点必须指定模型）。 */
export const testProviderInput = z.object({ id: z.string().min(1), model: z.string().min(1) });
export type TestProviderInput = z.infer<typeof testProviderInput>;

/**
 * 新建（无 id）或更新（带 id）一个 provider。
 * apiKey 两态语义（schema 仅允许这两态）：
 *  - 省略（undefined）→ 更新时保留既有密钥；新建时无密钥。
 *  - 提供非空字符串 → 加密后替换。
 * 不支持把 key 清空为 null（schema 拒 null/空串；如需移除整条记录用 remove）。
 */
export const upsertProviderInput = z.object({
  id: z.string().min(1).optional(),
  type: aiProviderApiType,
  label: z.string().nullish(),
  baseUrl: z.string().min(1).nullish(),
  apiKey: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).optional(),
});
export type UpsertProviderInput = z.infer<typeof upsertProviderInput>;
// 注：「openai-chat-completions 必须有可用 baseUrl」的规则**依赖 isBuiltin**（内置 DeepSeek 由工厂按
// type 派生、db 存 null 即合法），故不在此 input schema 里 refine，而在 repository.upsertProvider 按
// effective baseUrl（resolveProviderBaseUrl）判定。

/**
 * 密钥存在性的判别联合（仅这三态合法，非法组合不可表示）：
 *  - `none`：密文不存在。
 *  - `set`：密文存在且本机可解密，附掩码预览（如 "sk-…1234"）。
 *  - `undecryptable`：密文存在但本机无法解密（跨机器迁移 / safeStorage 不可用）。
 */
export type ProviderKeyState =
  | { status: "none" }
  | { status: "set"; mask: string }
  | { status: "undecryptable" };

/** 发往 renderer 的 provider 视图：绝不含明文 / 密文，只含掩码预览。 */
export interface ProviderDto {
  id: string;
  /** 当前选用的 API 端点格式（须 ∈ compatibleApis）。 */
  type: AiProviderApiType;
  /** 此 provider 兼容的 API 格式集合。length>1 时（且内置）允许在其中切换 type；否则 type 锁定。 */
  compatibleApis: AiProviderApiType[];
  label: string | null;
  baseUrl: string | null;
  key: ProviderKeyState;
  models: string[];
  /** 内置 provider（启动时按 DEFAULT_PROVIDERS 补齐）：label/baseUrl 不可改、不可删；type 仅可在 compatibleApis 内切。 */
  isBuiltin: boolean;
  createdAt: number;
}

/** reveal 返回的临时明文（仅用于 UI「👁 显示」）。 */
export const revealResult = z.object({ apiKey: z.string() });
export type RevealResult = z.infer<typeof revealResult>;

/** 列 provider 可用模型入参：key 解析 = 表单现填 apiKey ?? 由 id 解密的存储 key。 */
export const listModelsInput = z.object({
  type: aiProviderApiType,
  baseUrl: z.string().min(1).nullish(),
  apiKey: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});
export type ListModelsInput = z.infer<typeof listModelsInput>;

/** 拉模型返回（判别联合）：成功带 models；失败带真实 message，`status` 仅 HTTP 错误时有（网络层无）。 */
export const listModelsResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type ListModelsResult = z.infer<typeof listModelsResult>;

/** 测试连接结果（判别联合）。 */
export const testResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type TestResult = z.infer<typeof testResult>;
