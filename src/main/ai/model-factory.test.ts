import { describe, expect, it } from "vitest";
import {
  providerCallOptions,
  resolveLanguageModel,
  supportsImageToolResults,
} from "@main/ai/model-factory";

describe("resolveLanguageModel", () => {
  it("builds an openai model carrying the given model id", () => {
    const m = resolveLanguageModel({
      type: "openai-responses",
      baseUrl: null,
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
    expect(m.modelId).toBe("gpt-4o-mini");
  });
  it("builds an anthropic model", () => {
    const m = resolveLanguageModel({
      type: "anthropic",
      baseUrl: null,
      apiKey: "sk",
      model: "claude-haiku-4-5",
    });
    expect(m.modelId).toBe("claude-haiku-4-5");
  });
  it("builds a google model", () => {
    const m = resolveLanguageModel({
      type: "google-generate-content",
      baseUrl: null,
      apiKey: "sk",
      model: "gemini-2.0-flash",
    });
    expect(m.modelId).toBe("gemini-2.0-flash");
  });
  it("builds an openai-compatible model when baseUrl is provided", () => {
    const m = resolveLanguageModel({
      type: "openai-chat-completions",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk",
      model: "llama-3.2",
    });
    expect(m.modelId).toBe("llama-3.2");
  });
  it("throws for openai-compatible without a baseUrl", () => {
    expect(() =>
      resolveLanguageModel({
        type: "openai-chat-completions",
        baseUrl: null,
        apiKey: "sk",
        model: "x",
      }),
    ).toThrow(/baseUrl/i);
  });
});

describe("providerCallOptions", () => {
  it("forces store:false for openai-responses so reasoning items ride inline (encrypted_content) instead of as item_reference id lookups", () => {
    // 无状态中转/网关不持久化 Responses API 的 reasoning item（rs_…）；AI SDK 默认 store:true
    // 会以 item_reference(id) 回传上一步 reasoning，引用失效报「Item not found …store is set to false」。
    expect(providerCallOptions("openai-responses")).toEqual({ openai: { store: false } });
  });
  it("returns undefined for providers that have no Responses-store concern", () => {
    expect(providerCallOptions("anthropic")).toBeUndefined();
    expect(providerCallOptions("google-generate-content")).toBeUndefined();
    expect(providerCallOptions("openai-chat-completions")).toBeUndefined();
    expect(providerCallOptions(undefined)).toBeUndefined();
  });
});

describe("supportsImageToolResults", () => {
  it("allows providers whose SDK converts file-data tool results", () => {
    expect(supportsImageToolResults("anthropic")).toBe(true);
    expect(supportsImageToolResults("google-generate-content")).toBe(true);
    expect(supportsImageToolResults("openai-responses")).toBe(true);
  });
  it("denies openai-chat-completions (text-only tool messages) and undefined", () => {
    expect(supportsImageToolResults("openai-chat-completions")).toBe(false);
    expect(supportsImageToolResults(undefined)).toBe(false);
  });
});
