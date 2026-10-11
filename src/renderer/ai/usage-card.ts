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
