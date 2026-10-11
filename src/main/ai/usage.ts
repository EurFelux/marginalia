import type { LanguageModelUsage } from "ai";
import type { MessageUsage } from "@shared/types";
import { storableTokens } from "@main/usage/tokens";

/** 与 SDK 的 addTokenCounts 同规则：各步全为 undefined → undefined，否则缺项按 0 相加。 */
function sumTokens(values: (number | undefined)[]): number | undefined {
  return values.reduce<number | undefined>(
    (acc, v) => (acc == null && v == null ? undefined : (acc ?? 0) + (v ?? 0)),
    undefined,
  );
}

/**
 * 已完成各步的 usage → 落库的 metadata.usage（spec 2026-10-11 message-usage-display §4.2）。
 * 没有步骤或输入/输出总数拿不到时返回 undefined；拆分项为 undefined 的不写入。
 */
export function summarizeUsage(steps: readonly LanguageModelUsage[]): MessageUsage | undefined {
  const last = steps.at(-1);
  if (!last) return undefined;
  const inputTokens = storableTokens("inputTokens", sumTokens(steps.map((s) => s.inputTokens)));
  const outputTokens = storableTokens("outputTokens", sumTokens(steps.map((s) => s.outputTokens)));
  if (inputTokens == null || outputTokens == null) return undefined;

  const usage: MessageUsage = { inputTokens, outputTokens };
  const put = (
    field: Exclude<keyof MessageUsage, "inputTokens" | "outputTokens">,
    value?: number,
  ) => {
    const v = storableTokens(field, value);
    if (v != null) usage[field] = v;
  };
  put("cacheReadTokens", sumTokens(steps.map((s) => s.inputTokenDetails.cacheReadTokens)));
  put("cacheWriteTokens", sumTokens(steps.map((s) => s.inputTokenDetails.cacheWriteTokens)));
  put("noCacheTokens", sumTokens(steps.map((s) => s.inputTokenDetails.noCacheTokens)));
  put("reasoningTokens", sumTokens(steps.map((s) => s.outputTokenDetails.reasoningTokens)));
  put("stepCount", steps.length);
  put("lastStepInputTokens", last.inputTokens);
  return usage;
}
