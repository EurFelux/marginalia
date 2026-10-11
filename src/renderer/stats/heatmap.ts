import { STREAK_MIN_SECONDS, type DailyPoint } from "@shared/stats";

/** 热力图列数：最右一列是本周，往左 52 个整周（spec 2026-10-12-reading-stats-charts-design §3.1）。 */
export const HEATMAP_WEEKS = 53;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  day: string; // 'YYYY-MM-DD'
  seconds: number;
  level: HeatLevel;
}

export interface HeatmapGrid {
  /** 按列（周）排列，每列 7 格，自一周首日起；今天之后为 null。 */
  weeks: (HeatCell | null)[][];
  /** 月份标签：所在列与 'YYYY-MM'。 */
  months: { col: number; month: string }[];
  /** 第一列的 7 个日期，供取星期几的名称。 */
  weekdayDays: string[];
  /** 范围内达到「读过」门槛的天数。 */
  readDays: number;
  totalSeconds: number;
}

/** 三条分界：第 25、50、75 百分位的时长（秒）。 */
export type HeatThresholds = readonly [number, number, number];

/**
 * 四分位分界（§3.2）：读过（≥ 1 分钟）的日子按时长排序后，用最近秩法取第 25、50、75 百分位，
 * 取的是样本里的实际值。按分位而非最大值分档，个别极长的日子不会把其他日子压浅。
 * 没有读过的日子时返回 null（所有格子都是空格）。
 */
export function heatThresholds(seconds: readonly number[]): HeatThresholds | null {
  const read = seconds.filter((s) => s >= STREAK_MIN_SECONDS).sort((a, b) => a - b);
  if (read.length === 0) return null;
  const at = (p: number) => read[Math.ceil(p * read.length) - 1];
  return [at(0.25), at(0.5), at(0.75)];
}

/** 档位：不足 1 分钟为空格；其余不超过第一条分界为第 1 档，依此类推；等于分界归较浅一档。 */
export function heatLevel(seconds: number, thresholds: HeatThresholds | null): HeatLevel {
  if (seconds < STREAK_MIN_SECONDS || thresholds == null) return 0;
  const [q1, q2, q3] = thresholds;
  return seconds <= q1 ? 1 : seconds <= q2 ? 2 : seconds <= q3 ? 3 : 4;
}

/** 最左一列的月份标签与下一个标签至少隔这么多列，否则不标，免得文字重叠。 */
const FIRST_MONTH_LABEL_GAP = 3;

/**
 * 近一年热力图的网格（§3.1）。today 取 daily 的最后一天（主进程按本地日期零填充到今天），
 * firstDay 为一周首日（1 = 周一 … 7 = 周日，与 Temporal 的 dayOfWeek 一致）。
 */
export function heatmapGrid(
  daily: readonly DailyPoint[],
  today: string,
  firstDay: number,
): HeatmapGrid {
  const end = Temporal.PlainDate.from(today);
  const offset = (end.dayOfWeek - firstDay + 7) % 7;
  const start = end.subtract({ days: offset + (HEATMAP_WEEKS - 1) * 7 });
  const secondsOf = new Map(daily.map((d) => [d.day, d.seconds]));

  const dayAt = (col: number, row: number) => start.add({ days: col * 7 + row });
  const inRange: { day: string; seconds: number }[] = [];
  for (let d = start; Temporal.PlainDate.compare(d, end) <= 0; d = d.add({ days: 1 })) {
    const day = d.toString();
    inRange.push({ day, seconds: secondsOf.get(day) ?? 0 });
  }
  const thresholds = heatThresholds(inRange.map((d) => d.seconds));
  const level = new Map(inRange.map((d) => [d.day, heatLevel(d.seconds, thresholds)]));

  const weeks: (HeatCell | null)[][] = [];
  for (let col = 0; col < HEATMAP_WEEKS; col++) {
    const week: (HeatCell | null)[] = [];
    for (let row = 0; row < 7; row++) {
      const d = dayAt(col, row);
      if (Temporal.PlainDate.compare(d, end) > 0) {
        week.push(null);
        continue;
      }
      const day = d.toString();
      week.push({ day, seconds: secondsOf.get(day) ?? 0, level: level.get(day) ?? 0 });
    }
    weeks.push(week);
  }

  // 月份标在「第一天落在该月」的第一列上
  const months: HeatmapGrid["months"] = [];
  let prev = "";
  for (let col = 0; col < HEATMAP_WEEKS; col++) {
    const month = dayAt(col, 0).toPlainYearMonth().toString();
    if (month !== prev) months.push({ col, month });
    prev = month;
  }
  if (months.length > 1 && months[0].col === 0 && months[1].col < FIRST_MONTH_LABEL_GAP) {
    months.shift();
  }

  return {
    weeks,
    months,
    weekdayDays: Array.from({ length: 7 }, (_, row) => dayAt(0, row).toString()),
    readDays: inRange.filter((d) => d.seconds >= STREAK_MIN_SECONDS).length,
    totalSeconds: inRange.reduce((s, d) => s + d.seconds, 0),
  };
}
