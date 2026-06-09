import { z } from "zod";

/** 渲染层 → 主进程的 fire-and-forget **写**（非 getter）：上报「现在在读哪本书」，
 * 进/出 reader 时调用；设置弹窗遮挡 reader 时上报 null（暂停计时）。 */
export const statsReadingStateInput = z.object({ bookId: z.string().min(1).nullable() });
export type StatsReadingStateInput = z.infer<typeof statsReadingStateInput>;

/** 统计页取数；dailyDays 控制每日柱图窗口（省略时由 handler 兜底 30——
 * 不在此用 .default()：本仓库 invoker 的入参类型取 z.infer=output，default 会令该字段对调用方变必填）。 */
export const statsGetInput = z.object({
  dailyDays: z.number().int().positive().max(366).optional(),
});
export type StatsGetInput = z.infer<typeof statsGetInput>;

/** 某日合计（dailyTotals 的元素 / 柱图点）。 */
export interface DailyPoint {
  day: string; // 'YYYY-MM-DD'
  seconds: number;
}

/** 各书时长（perBookTotals 元素，仅现存书）。 */
export interface BookReadingTotal {
  bookId: string;
  title: string | null;
  author: string | null;
  seconds: number;
}

/** 统计页一次性数据。 */
export interface ReadingStatsDto {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number; // 滚动近 7 天（今天及前 6 天）
  currentStreak: number; // 天
  longestStreak: number; // 天
  readingDays: number; // 达标日总数（天）
  daily: DailyPoint[]; // 近 dailyDays 天，升序、零填充
  perBook: BookReadingTotal[]; // 按 seconds 降序，仅现存书
}
