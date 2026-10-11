import type { UsageBucket, UsageTotals } from "@shared/stats";

/** 缓存命中率；范围内没有任何报了缓存命中数的记录时为 null（显示「—」）。 */
export function hitRate(t: UsageTotals): number | null {
  return t.cacheKnownInputTokens > 0 ? t.cacheReadTokens / t.cacheKnownInputTokens : null;
}

/** 用量图一根柱子的三段：缓存命中 / 其余输入 / 输出（spec 2026-10-12-ai-usage-stats-design §3.4）。 */
export function bucketSegments(b: UsageBucket): { read: number; rest: number; out: number } {
  return {
    read: b.cacheReadTokens,
    rest: b.inputTokens - b.cacheReadTokens,
    out: b.outputTokens,
  };
}
