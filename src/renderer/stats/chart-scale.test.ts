import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  chartScale,
  durationScale,
  longDayLabel,
  shortMonthLabel,
  weekdayLabel,
} from "@renderer/stats/chart-scale";

describe("chartScale", () => {
  it("rounds the top up to a clean step with about four gridlines", () => {
    expect(chartScale(470_000)).toEqual({ top: 600_000, ticks: [0, 200_000, 400_000, 600_000] });
    expect(chartScale(1000)).toEqual({ top: 1000, ticks: [0, 500, 1000] });
  });
  it("handles an all-zero chart", () => {
    expect(chartScale(0)).toEqual({ top: 1, ticks: [0] });
  });
});

describe("bucketLabel", () => {
  it("formats days and months in the UI language", () => {
    expect(bucketLabel("2026-10-12", "day", "en")).toBe("10/12");
    expect(bucketLabel("2026-10", "month", "en")).toBe("Oct 2026");
    expect(bucketLabel("2026-10", "month", "zh-CN")).toBe("2026年10月");
  });
});

describe("durationScale", () => {
  it("picks the smallest step that covers a quarter of the maximum", () => {
    expect(durationScale(40 * 60)).toEqual({ top: 2400, ticks: [0, 600, 1200, 1800, 2400] });
    expect(durationScale(2 * 3600 + 40 * 60)).toEqual({
      top: 3 * 3600,
      ticks: [0, 3600, 7200, 10800],
    });
  });
  it("falls back to the largest step for very long days", () => {
    expect(durationScale(60 * 3600).ticks.at(1)).toBe(43200);
  });
  it("handles a month without reading", () => {
    expect(durationScale(0)).toEqual({ top: 300, ticks: [0] });
  });
});

describe("longDayLabel", () => {
  it("includes the weekday", () => {
    expect(longDayLabel("2026-10-12", "en")).toBe("Monday, October 12, 2026");
    expect(longDayLabel("2026-10-12", "zh-CN")).toBe("2026年10月12日星期一");
  });
});

describe("heatmap labels", () => {
  it("formats short month and weekday names in the UI language", () => {
    expect(shortMonthLabel("2026-10", "zh-CN")).toBe("10月");
    expect(shortMonthLabel("2026-10", "en")).toBe("Oct");
    expect(weekdayLabel("2026-10-12", "zh-CN")).toBe("周一");
    expect(weekdayLabel("2026-10-12", "en")).toBe("Mon");
  });
});
