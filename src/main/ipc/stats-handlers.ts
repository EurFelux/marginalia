import { C } from "@shared/ipc";
import type { ReadingStatsDto } from "@shared/stats";
import { getDb } from "@main/db/instance";
import { aggregateStats } from "@main/stats/aggregate";
import { localDayKey } from "@main/stats/day-key";
import { dailyTotals, perBookTotals } from "@main/stats/reading-daily";
import { getReadingClock } from "@main/stats/clock-wiring";
import { bind, register, type Binding } from "@main/ipc/registry";

export const statsBindings: Binding[] = [
  bind(C.statsReadingState, (input) => {
    getReadingClock().setReadingBook(input.bookId);
  }),
  bind(C.statsGet, (input): ReadingStatsDto => {
    const db = getDb();
    const core = aggregateStats(dailyTotals(db), input.dailyDays ?? 30, localDayKey(Date.now()));
    return { ...core, perBook: perBookTotals(db) };
  }),
];

export function registerStatsHandlers(): void {
  register(statsBindings);
}
