import { describe, expect, it } from "vitest";
import { formatTokens, usageCardView } from "@renderer/ai/usage-card";

describe("formatTokens", () => {
  it("keeps numbers below 1000 as they are", () => {
    expect(formatTokens(0, "en")).toBe("0");
    expect(formatTokens(912, "en")).toBe("912");
    expect(formatTokens(999, "en")).toBe("999");
  });

  it("switches to k, M and B with one decimal, dropping a trailing .0", () => {
    expect(formatTokens(1000, "en")).toBe("1k");
    expect(formatTokens(37060, "en")).toBe("37.1k");
    expect(formatTokens(16900, "en")).toBe("16.9k");
    expect(formatTokens(128_400, "en")).toBe("128.4k");
    expect(formatTokens(1_000_000, "en")).toBe("1M");
    expect(formatTokens(2_345_678, "en")).toBe("2.3M");
    expect(formatTokens(1_500_000_000, "en")).toBe("1.5B");
    expect(formatTokens(1_234_000_000_000, "en")).toBe("1,234B");
  });

  it("carries into the next unit when rounding reaches 1000", () => {
    expect(formatTokens(999_949, "en")).toBe("999.9k");
    expect(formatTokens(999_950, "en")).toBe("1M");
    expect(formatTokens(999_999_999, "en")).toBe("1B");
  });

  it("uses the locale's number format", () => {
    expect(formatTokens(37060, "zh-CN")).toBe("37.1k");
    expect(formatTokens(37060, "de")).toBe("37,1k");
  });
});

describe("usageCardView", () => {
  it("lists the full breakdown of a multi-step Anthropic turn", () => {
    const view = usageCardView(
      {
        inputTokens: 37060,
        outputTokens: 912,
        cacheReadTokens: 28400,
        cacheWriteTokens: 6200,
        noCacheTokens: 2460,
        reasoningTokens: 340,
        stepCount: 3,
        lastStepInputTokens: 16900,
      },
      "claude-sonnet-5-5",
      "complete",
    );
    expect(view).toEqual({
      model: "claude-sonnet-5-5",
      stepCount: 3,
      segments: [
        { kind: "cacheRead", tokens: 28400 },
        { kind: "cacheWrite", tokens: 6200 },
        { kind: "noCache", tokens: 2460 },
      ],
      rows: [
        { kind: "input", tokens: 37060 },
        { kind: "cacheRead", tokens: 28400 },
        { kind: "cacheWrite", tokens: 6200 },
        { kind: "noCache", tokens: 2460 },
        { kind: "output", tokens: 912 },
        { kind: "reasoning", tokens: 340 },
      ],
      contextTokens: 16900,
      note: undefined,
    });
  });

  it("omits rows the provider did not report but keeps reported zeros", () => {
    const view = usageCardView(
      { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, noCacheTokens: 100, stepCount: 1 },
      "deepseek-chat",
      "complete",
    );
    expect(view.rows.map((r) => r.kind)).toEqual(["input", "cacheRead", "noCache", "output"]);
    // 比例条只画大于 0 的段
    expect(view.segments).toEqual([{ kind: "noCache", tokens: 100 }]);
  });

  it("hides reasoning when it is zero", () => {
    const view = usageCardView(
      { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      undefined,
      "complete",
    );
    expect(view.rows.map((r) => r.kind)).toEqual(["input", "output"]);
  });

  it("shows only the two totals for messages stored before the breakdown existed", () => {
    const view = usageCardView({ inputTokens: 12480, outputTokens: 655 }, "m", "complete");
    expect(view.stepCount).toBeUndefined();
    expect(view.segments).toEqual([]);
    expect(view.rows.map((r) => r.kind)).toEqual(["input", "output"]);
    expect(view.contextTokens).toBeUndefined();
  });

  it("shows context only for multi-step turns", () => {
    const single = { inputTokens: 10, outputTokens: 1, stepCount: 1, lastStepInputTokens: 10 };
    expect(usageCardView(single, "m", "complete").contextTokens).toBeUndefined();
    expect(
      usageCardView({ ...single, stepCount: 2, inputTokens: 25 }, "m", "complete").contextTokens,
    ).toBe(10);
  });

  it("adds a note for aborted and errored turns", () => {
    const usage = { inputTokens: 10, outputTokens: 1 };
    expect(usageCardView(usage, "m", "aborted").note).toBe("aborted");
    expect(usageCardView(usage, "m", "error").note).toBe("error");
    expect(usageCardView(usage, "m", undefined).note).toBeUndefined();
  });
});
