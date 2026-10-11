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

/** 取整的刻度步长：1 / 2 / 5 × 10^n 中不小于 x 的最小值。 */
function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** 纵轴：顶值与刻度（约四格，取整）；全为 0 时只有 0 一个刻度，顶值取 1 以免除零。 */
export function chartScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/**
 * 柱子的日期标签：按天「10/12」，按月「2026年10月」/「Oct 2026」，跟随界面语言。
 * 不用 Temporal 的 toLocaleString：V8 对 ISO 日历的中文月份格式会退化成「2026/10」；
 * 改用 Intl.DateTimeFormat 格式化该日 UTC 零点的时刻（格式化也按 UTC，日期不会偏移）。
 */
export function bucketLabel(key: string, granularity: "day" | "month", locale: string): string {
  const day = Temporal.PlainDate.from(granularity === "day" ? key : `${key}-01`);
  const options: Intl.DateTimeFormatOptions =
    granularity === "day"
      ? { month: "numeric", day: "numeric" }
      : { year: "numeric", month: "short" };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    day.toZonedDateTime("UTC").epochMilliseconds,
  );
}
