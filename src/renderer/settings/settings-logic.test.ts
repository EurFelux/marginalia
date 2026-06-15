import { describe, expect, it } from "vitest";
import {
  mergeModels,
  providerModelOptions,
  providerFormToUpsertInput,
  clampStepLimit,
  clampBackgroundConcurrency,
} from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT, DEFAULT_BACKGROUND_CONCURRENCY } from "@shared/preferences";

describe("mergeModels", () => {
  it("unions and dedups, preserving order", () => {
    expect(mergeModels(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("providerModelOptions", () => {
  it("includes current model even if not in the provider list", () => {
    expect(providerModelOptions(["a", "b"], "x")).toEqual(["a", "b", "x"]);
    expect(providerModelOptions(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(providerModelOptions(["a"], null)).toEqual(["a"]);
  });
});

describe("clampStepLimit", () => {
  it("clamps to [1,99], truncates floats, falls back on non-finite", () => {
    expect(clampStepLimit(5)).toBe(5);
    expect(clampStepLimit(0)).toBe(1); // 0 不经数字框——这里是防御性收敛
    expect(clampStepLimit(100)).toBe(99);
    expect(clampStepLimit(3.7)).toBe(3);
    expect(clampStepLimit(NaN)).toBe(DEFAULT_STEP_LIMIT);
  });
});

describe("clampBackgroundConcurrency", () => {
  it("clamps to [1,10], truncates floats, falls back on non-finite", () => {
    expect(clampBackgroundConcurrency(3)).toBe(3);
    expect(clampBackgroundConcurrency(0)).toBe(1);
    expect(clampBackgroundConcurrency(11)).toBe(10);
    expect(clampBackgroundConcurrency(2.7)).toBe(2);
    expect(clampBackgroundConcurrency(NaN)).toBe(DEFAULT_BACKGROUND_CONCURRENCY);
  });
});

describe("providerFormToUpsertInput", () => {
  it("omits apiKey when not re-keyed; empty baseUrl -> null; passes models", () => {
    const out = providerFormToUpsertInput({
      id: "p1",
      type: "openai-responses",
      label: "L",
      baseUrl: "",
      apiKey: "",
      models: ["gpt-4o"],
    });
    expect(out).toEqual({
      id: "p1",
      type: "openai-responses",
      label: "L",
      baseUrl: null,
      models: ["gpt-4o"],
    });
  });
  it("includes apiKey when provided; label null when empty", () => {
    const out = providerFormToUpsertInput({
      id: undefined,
      type: "anthropic",
      label: "",
      baseUrl: "https://x",
      apiKey: "sk-1",
      models: [],
    });
    expect(out).toEqual({
      type: "anthropic",
      label: null,
      baseUrl: "https://x",
      apiKey: "sk-1",
      models: [],
    });
  });
});
