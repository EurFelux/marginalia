const TOKEN_UNITS = [
  { size: 1_000, suffix: "k" },
  { size: 1_000_000, suffix: "M" },
  { size: 1_000_000_000, suffix: "B" },
] as const;

/**
 * token 数的显示（spec 2026-10-11-message-usage-display §3.2）：不足 1000 写原数；
 * 否则换算成 k / M / B，保留一位小数，小数为 0 省掉。先按 0.1 个单位取整再定单位，
 * 999,950 显示为 1M 而不是 1,000k。用量卡与统计页共用。
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
