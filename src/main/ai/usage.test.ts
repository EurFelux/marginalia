import { describe, expect, it } from "vitest";
import type { LanguageModelUsage } from "ai";
import { summarizeUsage } from "@main/ai/usage";

function step(p: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  noCache?: number;
  reasoning?: number;
}): LanguageModelUsage {
  return {
    inputTokens: p.input,
    inputTokenDetails: {
      noCacheTokens: p.noCache,
      cacheReadTokens: p.cacheRead,
      cacheWriteTokens: p.cacheWrite,
    },
    outputTokens: p.output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: p.reasoning },
    totalTokens: undefined,
  };
}

describe("summarizeUsage", () => {
  it("returns undefined when no step completed", () => {
    expect(summarizeUsage([])).toBeUndefined();
  });

  it("sums every step and records step count and the last step's input", () => {
    const usage = summarizeUsage([
      step({ input: 100, output: 10, cacheRead: 0, cacheWrite: 80, noCache: 20, reasoning: 4 }),
      step({ input: 150, output: 20, cacheRead: 120, cacheWrite: 10, noCache: 20, reasoning: 0 }),
    ]);
    expect(usage).toEqual({
      inputTokens: 250,
      outputTokens: 30,
      cacheReadTokens: 120,
      cacheWriteTokens: 90,
      noCacheTokens: 40,
      reasoningTokens: 4,
      stepCount: 2,
      lastStepInputTokens: 150,
    });
  });

  it("omits breakdown fields the provider never reported", () => {
    // DeepSeek / Google：只报命中，不报写入
    const usage = summarizeUsage([step({ input: 50, output: 5, cacheRead: 30, noCache: 20 })]);
    expect(usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 30,
      noCacheTokens: 20,
      stepCount: 1,
      lastStepInputTokens: 50,
    });
    expect(usage).not.toHaveProperty("cacheWriteTokens");
    expect(usage).not.toHaveProperty("reasoningTokens");
  });

  it("counts a field missing from some steps as zero, like the SDK's own totals", () => {
    const usage = summarizeUsage([
      step({ input: 10, output: 1, reasoning: 3 }),
      step({ input: 20, output: 2 }),
    ]);
    expect(usage?.reasoningTokens).toBe(3);
  });

  it("returns undefined when the input or output total is unknown", () => {
    expect(summarizeUsage([step({ output: 5 })])).toBeUndefined();
    expect(summarizeUsage([step({ input: 5 })])).toBeUndefined();
  });

  it("drops values the stored schema would reject instead of losing the whole metadata", () => {
    const usage = summarizeUsage([step({ input: 50, output: 5, cacheRead: 60, noCache: -10 })]);
    expect(usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 60,
      stepCount: 1,
      lastStepInputTokens: 50,
    });
    expect(summarizeUsage([step({ input: -1, output: 5 })])).toBeUndefined();
  });
});
