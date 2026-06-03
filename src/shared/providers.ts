import { z } from "zod";

export const providerType = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type ProviderType = z.infer<typeof providerType>;

/** 各 type 官方默认端点：UI baseUrl 占位符 + 拉模型兜底共用（不注入生成路径——那交 SDK 自带默认）。 */
export const DEFAULT_BASE_URL: Record<ProviderType, string | null> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "openai-compatible": null,
};

/** provider type 的 UI 显示名（枚举值不变；按其讲的 API 命名）。 */
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai: "OpenAI Responses",
  "openai-compatible": "OpenAI Chat Completions",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

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
export const upsertProviderInput = z
  .object({
    id: z.string().min(1).optional(),
    type: providerType,
    label: z.string().nullish(),
    baseUrl: z.string().min(1).nullish(),
    apiKey: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => v.type !== "openai-compatible" || v.baseUrl != null, {
    message: "baseUrl is required for openai-compatible providers",
    path: ["baseUrl"],
  });
export type UpsertProviderInput = z.infer<typeof upsertProviderInput>;

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
  type: ProviderType;
  label: string | null;
  baseUrl: string | null;
  key: ProviderKeyState;
  models: string[];
  createdAt: number;
}

/** reveal 返回的临时明文（仅用于 UI「👁 显示」）。 */
export const revealResult = z.object({ apiKey: z.string() });
export type RevealResult = z.infer<typeof revealResult>;

/** 列 provider 可用模型入参：key 解析 = 表单现填 apiKey ?? 由 id 解密的存储 key。 */
export const listModelsInput = z.object({
  type: providerType,
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
