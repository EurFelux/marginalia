import { z } from "zod";

/** 渲染层 → 主进程的 fire-and-forget **写**（非 getter）：上报「现在在读哪本书」，
 * 进/出 reader 时调用；设置弹窗遮挡 reader 时上报 null（暂停计时）。 */
export const statsReadingStateInput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.literal("active"), bookId: z.string().min(1) }),
]);
export type StatsReadingStateInput = z.infer<typeof statsReadingStateInput>;

/** AI 用量账本的用途（spec 2026-10-12-ai-usage-stats-design §3.5）；与 ai_usage 表的 CHECK 约束一致。 */
export const USAGE_PURPOSES = [
  "chat",
  "summary",
  "report",
  "compaction",
  "memory",
  "naming",
] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

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

/** AI 用量统计的时间范围（spec 2026-10-12-ai-usage-stats-design §3.2）。 */
export const USAGE_RANGES = ["7d", "30d", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const statsUsageInput = z.object({ range: z.enum(USAGE_RANGES) });
export type StatsUsageInput = z.infer<typeof statsUsageInput>;

/**
 * 一组账本行的合计。缓存命中率 = cacheReadTokens ÷ cacheKnownInputTokens：
 * 分母只算报了缓存命中数的行——未报的是未知而非 0，算进去会压低命中率（§4.5）。
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheKnownInputTokens: number;
  requests: number;
}

/** 用量图的一根柱子：key 为本地日期 'YYYY-MM-DD'（按天）或 'YYYY-MM'（按月）。 */
export interface UsageBucket extends UsageTotals {
  key: string;
}

/** 按书分布的一行：书；第 10 本之后合并的「其余 N 本」；已删除的书；不属于某本书。 */
export type UsageBookRow =
  | { kind: "book"; bookId: string; title: string | null; author: string | null; tokens: number }
  | { kind: "others" | "deleted"; count: number; tokens: number }
  | { kind: "none"; tokens: number };

/** 统计页「AI 用量」标签一次性数据。tokens 一律指输入 + 输出。 */
export interface UsageStatsDto {
  /** 账本里是否有任何记录（与范围无关；没有则整个标签显示空状态）。 */
  hasAnyUsage: boolean;
  granularity: "day" | "month";
  /** 范围天数（近 N 天）；「全部」为 null。 */
  days: number | null;
  totals: UsageTotals;
  series: UsageBucket[];
  /** 按 tokens 降序，只含大于 0 的用途。 */
  byPurpose: { purpose: UsagePurpose; tokens: number }[];
  /** 按 tokens 降序；model 为 null 是回填时消息没记模型。 */
  byModel: ({ model: string | null } & UsageTotals)[];
  byBook: UsageBookRow[];
}
