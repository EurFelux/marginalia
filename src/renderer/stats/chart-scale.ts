/** 两张柱状图共用的刻度与日期标签（spec 2026-10-12-reading-stats-charts-design §5）。 */

export interface ChartScale {
  /** 纵轴顶值（> 0）。 */
  top: number;
  /** 从 0 起的刻度值。 */
  ticks: number[];
}

/** 按步长铺刻度：顶值向上取整到步长的整数倍；最大值为 0 时只有 0 一个刻度，顶值取步长以免除零。 */
function scaleWithStep(max: number, step: number): ChartScale {
  if (max <= 0) return { top: step, ticks: [0] };
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/** 取整的刻度步长：1 / 2 / 5 × 10^n 中不小于 x 的最小值。 */
function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** token 纵轴：步长取 1 / 2 / 5 × 10ⁿ，约四格；全为 0 时只有 0 一个刻度。 */
export function chartScale(max: number): ChartScale {
  return max <= 0 ? scaleWithStep(0, 1) : scaleWithStep(max, niceStep(max / 4));
}

/** 时长纵轴的步长档位（秒）：5、10、15、30 分钟，1、2、3、4、6、12 小时。 */
const DURATION_STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200];

/** 时长纵轴：取不小于最大值四分之一的最小一档作步长；超出档位用最大一档。 */
export function durationScale(maxSeconds: number): ChartScale {
  const step =
    DURATION_STEPS.find((s) => s >= maxSeconds / 4) ?? DURATION_STEPS[DURATION_STEPS.length - 1];
  return scaleWithStep(maxSeconds, step);
}

/**
 * 以下日期标签都不用 Temporal 的 toLocaleString：V8 对 ISO 日历的中文月份格式会退化成「2026/10」。
 * 改用 Intl.DateTimeFormat 格式化该日 UTC 零点的时刻，格式化也按 UTC，日期不会偏移。
 */
const utcMs = (day: string) =>
  Temporal.PlainDate.from(day).toZonedDateTime("UTC").epochMilliseconds;

/** 柱子的日期标签：按天「10/12」，按月「2026年10月」/「Oct 2026」，跟随界面语言。 */
export function bucketLabel(key: string, granularity: "day" | "month", locale: string): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === "day"
      ? { month: "numeric", day: "numeric" }
      : { year: "numeric", month: "short" };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    utcMs(granularity === "day" ? key : `${key}-01`),
  );
}

/** 提示框里的完整日期（带星期）：「2026年10月12日星期一」/「Monday, October 12, 2026」。 */
export function longDayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(utcMs(day));
}

/** 热力图顶部的月份简称：「10月」/「Oct」。month 为 'YYYY-MM'。 */
export function shortMonthLabel(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(
    utcMs(`${month}-01`),
  );
}

/** 热力图左侧的星期简称：「周一」/「Mon」。 */
export function weekdayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(utcMs(day));
}
