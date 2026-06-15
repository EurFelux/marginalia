import type { DB } from "@main/db/client";
import { dailyTotals, perBookTotals } from "@main/stats/reading-daily";
import { localDayKey } from "@main/stats/day-key";
import type { DailyPoint, ReadingStatsDto } from "@shared/stats";

/** 当天合计达此秒数才算「读过书的一天」（streak / readingDays 计入门槛）。 */
export const STREAK_MIN_SECONDS = 60;

/** 'YYYY-MM-DD' 加减天（按本地分量构造 Date 做日历运算，时区稳定）。 */
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 全历史日合计 → 统计 DTO（除 perBook）。 */
export function aggregateStats(
  rows: DailyPoint[],
  dailyDays: number,
  today: string,
): Omit<ReadingStatsDto, "perBook"> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.day, (map.get(r.day) ?? 0) + r.seconds);
  const secondsOf = (day: string) => map.get(day) ?? 0;
  const qualifies = (day: string) => secondsOf(day) >= STREAK_MIN_SECONDS;

  let totalSeconds = 0;
  for (const v of map.values()) totalSeconds += v;

  const todaySeconds = secondsOf(today);

  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) weekSeconds += secondsOf(addDays(today, -i));

  const daily: DailyPoint[] = [];
  for (let i = dailyDays - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    daily.push({ day, seconds: secondsOf(day) });
  }

  // current streak：锚点 = 今天(达标) 否则昨天(达标) 否则无；自锚点向前数连续达标。
  let anchor: string | null = null;
  if (qualifies(today)) anchor = today;
  else if (qualifies(addDays(today, -1))) anchor = addDays(today, -1);
  let currentStreak = 0;
  for (let cur = anchor; cur != null && qualifies(cur); cur = addDays(cur, -1)) currentStreak++;

  // longest streak：全历史达标日的最长连续段。
  // 'YYYY-MM-DD' 字典序即时间序（ISO 8601），故 .sort() 无需比较器。
  const qualifyingDays = [...map.keys()].filter(qualifies).sort();
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of qualifyingDays) {
    run = prev != null && addDays(prev, 1) === day ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = day;
  }

  return {
    totalSeconds,
    todaySeconds,
    weekSeconds,
    currentStreak,
    longestStreak,
    readingDays: qualifyingDays.length,
    daily,
  };
}

/** Stats 视图默认窗口（与 statsGet handler 的 `?? 30` 对齐）。 */
export const DEFAULT_DAILY_DAYS = 30;

/**
 * 纯函数（注入 DB）组装完整 ReadingStatsDto。
 * 供书库 AI 工具（library-tools）与 stats handler 共用，避免重复拼装逻辑。
 */
export function aggregateReadingStats(db: DB): ReadingStatsDto {
  const core = aggregateStats(dailyTotals(db), DEFAULT_DAILY_DAYS, localDayKey(Date.now()));
  return { ...core, perBook: perBookTotals(db) };
}
