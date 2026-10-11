import { describe, expect, it } from "vitest";
import { HEATMAP_WEEKS, heatLevel, heatmapGrid } from "@renderer/stats/heatmap";

const TODAY = "2026-10-12"; // 周一

describe("heatLevel", () => {
  it("leaves days under a minute empty and splits the rest by the longest day", () => {
    expect(heatLevel(30, 3600)).toBe(0);
    expect(heatLevel(60, 3600)).toBe(1);
    expect(heatLevel(900, 3600)).toBe(1);
    expect(heatLevel(901, 3600)).toBe(2);
    expect(heatLevel(2700, 3600)).toBe(3);
    expect(heatLevel(3600, 3600)).toBe(4);
    expect(heatLevel(0, 0)).toBe(0);
  });
});

describe("heatmapGrid", () => {
  it("lays out 53 Monday-first weeks ending with the current week", () => {
    const grid = heatmapGrid([], TODAY, 1);
    expect(grid.weeks).toHaveLength(HEATMAP_WEEKS);
    expect(grid.weeks[0][0]?.day).toBe("2025-10-13");
    expect(grid.weekdayDays[0]).toBe("2025-10-13");
    // 今天是周一：最后一列只有今天，之后留白
    expect(grid.weeks.at(-1)?.map((c) => c?.day ?? null)).toEqual([
      "2026-10-12",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("starts weeks on Sunday when the locale does", () => {
    const grid = heatmapGrid([], TODAY, 7);
    expect(grid.weeks[0][0]?.day).toBe("2025-10-12");
    expect(
      grid.weeks
        .at(-1)
        ?.slice(0, 3)
        .map((c) => c?.day ?? null),
    ).toEqual(["2026-10-11", "2026-10-12", null]);
  });

  it("levels each day against the longest day in range and counts read days", () => {
    const grid = heatmapGrid(
      [
        { day: "2026-10-12", seconds: 3600 },
        { day: "2026-10-11", seconds: 1000 },
        { day: "2026-10-10", seconds: 30 },
        { day: "2024-01-01", seconds: 99999 }, // 范围外，不参与最长值
      ],
      TODAY,
      1,
    );
    const cell = (day: string) => grid.weeks.flat().find((c) => c?.day === day);
    expect(cell("2026-10-12")?.level).toBe(4);
    expect(cell("2026-10-11")?.level).toBe(2);
    expect(cell("2026-10-10")?.level).toBe(0);
    expect(grid.readDays).toBe(2);
    expect(grid.totalSeconds).toBe(4630);
  });

  it("labels each month on the first column that starts in it", () => {
    const grid = heatmapGrid([], TODAY, 1);
    // 第一列从 2025-10-13 起，11 月从第 3 列（11-03）起：隔了 3 列，十月照常标
    expect(grid.months.slice(0, 2)).toEqual([
      { col: 0, month: "2025-10" },
      { col: 3, month: "2025-11" },
    ]);
    expect(grid.months.at(-1)).toEqual({ col: 51, month: "2026-10" });
    expect(grid.months).toHaveLength(13);
  });

  it("drops the first month label when the next one is too close", () => {
    // 第一列从 2025-10-27 起，11 月从第 1 列起：太挤，十月不标
    const grid = heatmapGrid([], "2026-10-26", 1);
    expect(grid.months[0]).toEqual({ col: 1, month: "2025-11" });
  });
});
