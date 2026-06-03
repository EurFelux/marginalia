const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/** 选出相对时间的 {数值, 单位}（fromMs 过去 → 负值）。纯函数、可测，不碰 locale。 */
export function relativeParts(
  fromMs: number,
  nowMs: number,
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  let duration = (fromMs - nowMs) / 1000;
  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(duration) < amount) return { value: Math.round(duration), unit };
    duration /= amount;
  }
  return { value: Math.round(duration), unit: "year" };
}

/** 本地化相对时间串（如「3 天前」/"3 days ago"）。locale 取 i18n.language。 */
export function relativeTime(fromMs: number, nowMs: number, locale: string): string {
  const { value, unit } = relativeParts(fromMs, nowMs);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
