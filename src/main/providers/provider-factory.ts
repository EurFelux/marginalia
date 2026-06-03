import { resolveProviderBaseUrl } from "@shared/providers";
import type { ProviderRow } from "@main/providers/repository";

declare const PROVIDER_BRAND: unique symbol;

/**
 * 已解析、可供下游模型构建消费的 provider 实例。`baseUrl` 已按当前 type 派生
 * （DeepSeek 这类 `db.baseUrl` 为 null 的内置在此一次性特判）。
 *
 * **品牌类型**：只能由 {@link createProvider} 产出。建模型的下游函数声明接收 `Provider`，
 * 即从类型上强制走工厂，杜绝直接拿 db 行那个对 DeepSeek 为 null 的 baseUrl 去建模型。
 */
export type Provider = ProviderRow & { readonly [PROVIDER_BRAND]: true };

/** 把 db 行解析为下游可消费的 {@link Provider} 实例（品牌的唯一产出点）。 */
export function createProvider(row: ProviderRow): Provider {
  return { ...row, baseUrl: resolveProviderBaseUrl(row, row.type) } as Provider;
}
