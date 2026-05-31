import { z } from "zod";

export const providerType = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type ProviderType = z.infer<typeof providerType>;

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
  })
  .refine((v) => v.type !== "openai-compatible" || v.baseUrl != null, {
    message: "baseUrl is required for openai-compatible providers",
    path: ["baseUrl"],
  });
export type UpsertProviderInput = z.infer<typeof upsertProviderInput>;

/** 发往 renderer 的 provider 视图：绝不含明文 / 密文，只含掩码预览。 */
export interface ProviderDto {
  id: string;
  type: ProviderType;
  label: string | null;
  baseUrl: string | null;
  /** 掩码预览（如 "sk-…1234"）；无密钥或无法解密时为 null。 */
  keyMask: string | null;
  /** 是否存有密钥（密文存在）。 */
  hasKey: boolean;
  /** 存有密钥但本机无法解密时为 false（如跨机器迁移 / safeStorage 不可用）。无密钥时亦为 false——应配合 hasKey 一同判断。 */
  keyDecryptable: boolean;
  createdAt: number;
}

/** reveal 返回的临时明文（仅用于 UI「👁 显示」）。 */
export const revealResult = z.object({ apiKey: z.string() });
export type RevealResult = z.infer<typeof revealResult>;

/** 测试连接结果（判别联合）。 */
export const testResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type TestResult = z.infer<typeof testResult>;
