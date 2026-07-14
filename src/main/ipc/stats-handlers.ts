import { C } from "@shared/ipc";
import type { ReadingStatsDto } from "@shared/stats";
import { getDb } from "@main/db/instance";
import { aggregateStats, aggregateReadingStats } from "@main/stats/aggregate";
import { localDayKey } from "@main/stats/day-key";
import { dailyTotals, perBookTotals } from "@main/stats/reading-daily";
import { getReadingClock } from "@main/stats/clock-wiring";
import { getActiveReadingSession } from "@main/reading-sessions/repository";
import { bind, register, type Binding } from "@main/ipc/registry";

export const statsBindings: Binding[] = [
  bind(C.statsReadingState, (input) => {
    if (input.status === "idle") return getReadingClock().setReadingBook(null);
    if (!getActiveReadingSession(getDb(), input.bookId))
      throw new Error(`stats:reading-state — book ${input.bookId} has no active reading session`);
    getReadingClock().setReadingBook(input.bookId);
  }),
  bind(C.statsGet, (input): ReadingStatsDto => {
    const db = getDb();
    // dailyDays 省略时走 aggregateReadingStats（默认 30 天）；提供时走 aggregateStats 支持自定义窗口。
    if (input.dailyDays == null) return aggregateReadingStats(db);
    const core = aggregateStats(dailyTotals(db), input.dailyDays, localDayKey(Date.now()));
    return { ...core, perBook: perBookTotals(db) };
  }),
];

export function registerStatsHandlers(): void {
  register(statsBindings);
}
