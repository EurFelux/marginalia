import { describe, expect, it } from "vitest";
import { bucketLabel, bucketSegments, chartScale, hitRate } from "@renderer/stats/usage/usage-view";

const totals = (over: Partial<Parameters<typeof hitRate>[0]>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheKnownInputTokens: 0,
  requests: 0,
  ...over,
});

describe("hitRate", () => {
  it("divides cache reads by the input of rows that reported them", () => {
    expect(hitRate(totals({ cacheReadTokens: 80, cacheKnownInputTokens: 200 }))).toBe(0.4);
  });
  it("is null when no row reported cache reads", () => {
    expect(hitRate(totals({ inputTokens: 500 }))).toBeNull();
  });
});

describe("bucketSegments", () => {
  it("splits input into cache reads and the rest, then output", () => {
    expect(
      bucketSegments({
        key: "2026-10-12",
        ...totals({ inputTokens: 100, cacheReadTokens: 70, outputTokens: 5 }),
      }),
    ).toEqual({ read: 70, rest: 30, out: 5 });
  });
});

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
