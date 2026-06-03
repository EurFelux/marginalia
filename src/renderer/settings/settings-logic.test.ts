import { describe, expect, it } from "vitest";
import {
  mergeModels,
  assistantModelOptions,
  providerFormToUpsertInput,
} from "@renderer/settings/settings-logic";

describe("mergeModels", () => {
  it("unions and dedups, preserving order", () => {
    expect(mergeModels(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("assistantModelOptions", () => {
  it("includes current model even if not in the provider list", () => {
    expect(assistantModelOptions(["a", "b"], "x")).toEqual(["a", "b", "x"]);
    expect(assistantModelOptions(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(assistantModelOptions(["a"], null)).toEqual(["a"]);
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
