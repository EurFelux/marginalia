import type { MessageStatus, MessageUsage } from "@shared/types";

export type InputSegment = "cacheRead" | "cacheWrite" | "noCache";
export type UsageRowKind = "input" | InputSegment | "output" | "reasoning";

export interface UsageCardView {
  model?: string;
  stepCount?: number;
  /** 输入构成比例条：provider 报了且大于 0 的段；为空则不画。 */
  segments: { kind: InputSegment; tokens: number }[];
  /** 按显示顺序；input / output 是主行，其余是缩进的子行。 */
  rows: { kind: UsageRowKind; tokens: number }[];
  /** 多步回合最后一步的输入；单步时它等于输入，省略。 */
  contextTokens?: number;
  /** 中止 / 出错的回合只计了已完成的步骤。 */
  note?: "aborted" | "error";
}

const INPUT_SEGMENTS = [
  ["cacheRead", "cacheReadTokens"],
  ["cacheWrite", "cacheWriteTokens"],
  ["noCache", "noCacheTokens"],
] as const satisfies readonly (readonly [InputSegment, keyof MessageUsage])[];

const TOKEN_UNITS = [
  { size: 1_000, suffix: "k" },
  { size: 1_000_000, suffix: "M" },
  { size: 1_000_000_000, suffix: "B" },
] as const;

/**
 * token 数的显示（§3.2）：不足 1000 写原数；否则换算成 k / M / B，保留一位小数，小数为 0 省掉。
 * 先按 0.1 个单位取整再定单位，999,950 显示为 1M 而不是 1,000k。
 */
export function formatTokens(n: number, locale: string): string {
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  let i = TOKEN_UNITS.findLastIndex((u) => n >= u.size);
  if (i < 0) return fmt.format(n);
  let tenths = Math.round((n * 10) / TOKEN_UNITS[i].size);
  if (tenths >= 10_000 && i < TOKEN_UNITS.length - 1) {
    i += 1;
    tenths = Math.round((n * 10) / TOKEN_UNITS[i].size);
  }
  return fmt.format(tenths / 10) + TOKEN_UNITS[i].suffix;
}

/** 用量卡显示哪些项（spec 2026-10-11 message-usage-display §3.2 的逐项规则）。 */
export function usageCardView(
  usage: MessageUsage,
  model: string | undefined,
  status: MessageStatus | undefined,
): UsageCardView {
  // 报了就显示，值为 0 也显示；没报（undefined）的整行省掉
  const breakdown = INPUT_SEGMENTS.flatMap(([kind, field]) => {
    const tokens = usage[field];
    return tokens == null ? [] : [{ kind, tokens }];
  });
  const rows: UsageCardView["rows"] = [
    { kind: "input", tokens: usage.inputTokens },
    ...breakdown,
    { kind: "output", tokens: usage.outputTokens },
  ];
  if (usage.reasoningTokens) rows.push({ kind: "reasoning", tokens: usage.reasoningTokens });
  return {
    model,
    stepCount: usage.stepCount,
    segments: breakdown.filter((s) => s.tokens > 0),
    rows,
    contextTokens: (usage.stepCount ?? 0) > 1 ? usage.lastStepInputTokens : undefined,
    note: status === "aborted" || status === "error" ? status : undefined,
  };
}
