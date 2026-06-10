import { asc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { providers } from "@main/db/schema";
import type { ProviderTester } from "@main/secrets/tester";
import { maskKey } from "@main/providers/mask";
import { createProvider, type Provider } from "@main/providers/provider-factory";
import { t } from "@main/i18n";
import type { ProviderDto, TestResult, UpsertProviderInput } from "@shared/providers";

export type ProviderRow = typeof providers.$inferSelect;

/**
 * Provider → DTO（明文仅在 main；DTO 只携掩码）。入参经工厂解析，故 baseUrl 已按 type 派生。
 * apiKey 两态：省略=保留既有，提供=替换（明文直存，见 2026-06-04 spec）。
 * label / baseUrl 同理：省略=保留，显式 null=清空（两态；新建时 ?? null 回退正确）。
 */
function toDto(provider: Provider): ProviderDto {
  return {
    id: provider.id,
    type: provider.type,
    compatibleApis: provider.compatibleApis ?? [provider.type],
    label: provider.label ?? null,
    baseUrl: provider.baseUrl, // 工厂已派生（DeepSeek 等内置不再是 db 里的 null）
    keyMask: provider.apiKey == null ? null : maskKey(provider.apiKey),
    models: provider.models ?? [],
    isBuiltin: provider.isBuiltin,
    createdAt: provider.createdAt,
  };
}

export function getProviderRow(db: DB, id: string): ProviderRow | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

/** 取 provider 并经工厂解析为下游可消费的 {@link Provider}（baseUrl 已按 type 派生）。 */
export function loadProvider(db: DB, id: string): Provider | undefined {
  const row = getProviderRow(db, id);
  return row ? createProvider(row) : undefined;
}

export function listProviders(db: DB): ProviderDto[] {
  return db
    .select()
    .from(providers)
    .orderBy(asc(providers.createdAt))
    .all()
    .map((r) => toDto(createProvider(r)));
}

/**
 * 用户自建（非内置）provider 必须显式提供 baseUrl——内置才走默认端点 / 工厂派生免填
 * （OpenAI/Anthropic/Gemini 用各 type 官方端点，DeepSeek 按 type 派生）。
 * 该规则依赖 isBuiltin，故在仓储而非 Zod input schema 中强制。
 */
function assertUsableBaseUrl(p: { isBuiltin: boolean; baseUrl: string | null }): void {
  if (!p.isBuiltin && p.baseUrl == null) {
    throw new Error(t("errors.baseUrlRequiredCustom", "自建$t(terms.provider)必须填写 baseUrl"));
  }
}

export function upsertProvider(db: DB, input: UpsertProviderInput): ProviderDto {
  if (input.id) {
    const existing = getProviderRow(db, input.id);
    if (!existing)
      throw new Error(
        t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id: input.id }),
      );
    // 内置 provider：label / baseUrl 不可改；type 仅可在 compatibleApis 内切换。main 侧防御非法改动。
    if (existing.isBuiltin) {
      const compat = existing.compatibleApis ?? [existing.type];
      if (input.type !== existing.type && !compat.includes(input.type)) {
        throw new Error(
          t("errors.builtinTypeOutsideCompat", "内置$t(terms.provider)的类型只能在兼容 API 内切换"),
        );
      }
      if (input.label != null && input.label !== existing.label) {
        throw new Error(t("errors.builtinLabelLocked", "内置$t(terms.provider)的名称不可修改"));
      }
      if (input.baseUrl != null && input.baseUrl !== existing.baseUrl) {
        throw new Error(
          t("errors.builtinBaseUrlLocked", "内置$t(terms.provider)的 baseUrl 不可修改"),
        );
      }
    }
    const lockedMeta = existing.isBuiltin; // label / baseUrl 锁定
    // 按更新后的最终态校验（内置豁免；非内置 baseUrl：省略=沿用 existing，显式=用新值——清空会被此拦下）。
    const finalBaseUrl = lockedMeta
      ? existing.baseUrl
      : input.baseUrl !== undefined
        ? input.baseUrl
        : existing.baseUrl;
    assertUsableBaseUrl({ isBuiltin: existing.isBuiltin, baseUrl: finalBaseUrl });
    const row = db
      .update(providers)
      .set({
        type: input.type, // type 已校验（内置限 compatibleApis；非内置自由）
        ...(!lockedMeta && input.label !== undefined ? { label: input.label } : {}),
        ...(!lockedMeta && input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.models !== undefined ? { models: input.models } : {}),
        // 非内置：compatibleApis 跟随当前 type（内置 compatibleApis 由 config 固定，不动）。
        ...(!existing.isBuiltin ? { compatibleApis: [input.type] } : {}),
      })
      .where(eq(providers.id, input.id))
      .returning()
      .get();
    if (!row)
      throw new Error(
        t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id: input.id }),
      );
    return toDto(createProvider(row));
  }

  // 用户自建（非内置）：必须显式给 baseUrl（无默认端点 / 工厂派生豁免）。
  assertUsableBaseUrl({ isBuiltin: false, baseUrl: input.baseUrl ?? null });
  const inserted = db
    .insert(providers)
    .values({
      type: input.type,
      compatibleApis: [input.type], // 用户自建：单一当前 type
      label: input.label ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKey: input.apiKey ?? null,
      models: input.models ?? [],
    })
    .returning()
    .get();
  return toDto(createProvider(inserted));
}

export function removeProvider(db: DB, id: string): void {
  const row = getProviderRow(db, id);
  if (!row)
    throw new Error(t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id }));
  if (row.isBuiltin)
    throw new Error(t("errors.builtinUndeletable", "内置$t(terms.provider)不可删除"));
  // chatModel / summaryModel 偏好按 providerId 引用（无 FK，存 JSON）：删 provider 后留作悬空引用，
  // 由 resolveChatModel / resolveSummaryModel 在解析时报「未找到 provider」优雅降级，无需在此清理。
  db.delete(providers).where(eq(providers.id, id)).run();
}

export function revealProviderKey(db: DB, id: string): string {
  const row = getProviderRow(db, id);
  if (!row)
    throw new Error(t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id }));
  if (row.apiKey == null)
    throw new Error(
      t("errors.providerHasNoApiKey", "$t(terms.provider) {{id}} 未配置密钥", { id }),
    );
  return row.apiKey;
}

export async function testProvider(
  db: DB,
  tester: ProviderTester,
  id: string,
  model: string,
): Promise<TestResult> {
  const provider = loadProvider(db, id);
  if (!provider)
    throw new Error(t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id }));
  if (provider.apiKey == null) {
    return { ok: false, message: t("errors.noApiKeySet", "该$t(terms.provider)未配置密钥") };
  }
  // provider.baseUrl 已由工厂按 type 派生（DeepSeek 特判集中在此一处）。
  return tester.test({
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
  });
}
