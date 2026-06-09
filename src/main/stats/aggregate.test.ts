import { describe, expect, it } from "vitest";
import { aggregateStats } from "@main/stats/aggregate";

describe("aggregateStats", () => {
  const today = "2026-06-09";

  it("computes total / today / rolling-week", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 600 }, // today
        { day: "2026-06-05", seconds: 300 }, // within 7d
        { day: "2026-06-02", seconds: 100 }, // outside 7d (today-7)
      ],
      30,
      today,
    );
    expect(r.totalSeconds).toBe(1000);
    expect(r.todaySeconds).toBe(600);
    expect(r.weekSeconds).toBe(900); // 06-03..06-09 含 today 及前6天
  });

  it("daily is ascending, zero-filled, windowed to dailyDays", () => {
    const r = aggregateStats([{ day: "2026-06-09", seconds: 120 }], 3, today);
    expect(r.daily).toEqual([
      { day: "2026-06-07", seconds: 0 },
      { day: "2026-06-08", seconds: 0 },
      { day: "2026-06-09", seconds: 120 },
    ]);
  });

  it("daily window does not affect total/streak (full history counts)", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 120 },
        { day: "2026-01-01", seconds: 999 }, // 在 dailyDays=3 窗口外
      ],
      3,
      today,
    );
    expect(r.totalSeconds).toBe(1119);
    expect(r.daily).toHaveLength(3); // 不含 01-01
  });

  it("counts a day toward streak only at >= 60s", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 60 },
        { day: "2026-06-08", seconds: 59 }, // 不达标 → 断
        { day: "2026-06-07", seconds: 120 },
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(1); // 仅 today
    expect(r.readingDays).toBe(2); // 06-09 与 06-07
  });

  it("current streak counts consecutive qualifying days ending today", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 100 },
        { day: "2026-06-08", seconds: 100 },
        { day: "2026-06-07", seconds: 100 },
        { day: "2026-06-05", seconds: 100 }, // 06-06 缺 → 断
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(3);
  });

  it("grace: streak alive through yesterday when today not read yet", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-08", seconds: 100 },
        { day: "2026-06-07", seconds: 100 },
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(2); // today 未读但昨日达标，宽限
  });

  it("current streak is 0 when neither today nor yesterday qualifies", () => {
    const r = aggregateStats([{ day: "2026-06-06", seconds: 100 }], 30, today);
    expect(r.currentStreak).toBe(0);
  });

  it("longest streak is max run over all history", () => {
    const r = aggregateStats(
      [
        { day: "2026-05-01", seconds: 100 },
        { day: "2026-05-02", seconds: 100 },
        { day: "2026-05-03", seconds: 100 },
        { day: "2026-05-04", seconds: 100 }, // 4 连
        { day: "2026-06-09", seconds: 100 }, // 单独 1
      ],
      30,
      today,
    );
    expect(r.longestStreak).toBe(4);
  });
});
