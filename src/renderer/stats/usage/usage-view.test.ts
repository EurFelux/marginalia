import { describe, expect, it } from "vitest";
import { bucketSegments, hitRate } from "@renderer/stats/usage/usage-view";

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
