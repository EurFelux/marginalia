import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import type { DBTransaction } from "@main/db/client";
import { aiUsage } from "@main/db/schema";
import { storableTokens } from "@main/usage/tokens";
import type { UsagePurpose } from "@shared/stats";

/** 账本的 token 列；拆分项为 null 表示 provider 没报（未知），不是 0。 */
export interface LedgerTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  noCacheTokens: number | null;
  reasoningTokens: number | null;
}

/** 账本的一行（spec 2026-10-12-ai-usage-stats-design §4.1）。 */
export interface UsageEntry extends LedgerTokens {
  createdAt: number;
  purpose: UsagePurpose;
  model: string | null;
  bookId: string | null;
  requests: number;
}

/** provider 单次请求的原始用量 → 账本列；总输入或总输出拿不到时返回 undefined。 */
export function ledgerTokens(usage: LanguageModelV4Usage): LedgerTokens | undefined {
  const inputTokens = storableTokens("inputTokens", usage.inputTokens.total);
  const outputTokens = storableTokens("outputTokens", usage.outputTokens.total);
  if (inputTokens == null || outputTokens == null) return undefined;
  const optional = (field: string, value: number | undefined) =>
    storableTokens(field, value) ?? null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: optional("cacheReadTokens", usage.inputTokens.cacheRead),
    cacheWriteTokens: optional("cacheWriteTokens", usage.inputTokens.cacheWrite),
    noCacheTokens: optional("noCacheTokens", usage.inputTokens.noCache),
    reasoningTokens: optional("reasoningTokens", usage.outputTokens.reasoning),
  };
}

/** 追加一行账本（可在事务内调用）。 */
export function insertUsage(db: DBTransaction, entry: UsageEntry): void {
  db.insert(aiUsage).values(entry).run();
}
