import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  PROVIDER_TYPE_LABEL,
  isDeepseekProvider,
  listModelsInput,
  listModelsResult,
  aiProviderApiType,
  resolveProviderBaseUrl,
  testProviderInput,
  upsertProviderInput,
} from "@shared/providers";

describe("upsertProviderInput", () => {
  it("accepts a minimal create (type only)", () => {
    expect(upsertProviderInput.safeParse({ type: "openai-responses" }).success).toBe(true);
  });

  it("rejects an unknown provider type", () => {
    expect(upsertProviderInput.safeParse({ type: "cohere" }).success).toBe(false);
  });

  it("structurally accepts openai-chat-completions without baseUrl (the baseUrl-required rule lives in repository, not the schema — internal DeepSeek derives it)", () => {
    expect(upsertProviderInput.safeParse({ type: "openai-chat-completions" }).success).toBe(true);
  });

  it("accepts openai-compatible when baseUrl is provided", () => {
    expect(
      upsertProviderInput.safeParse({
        type: "openai-chat-completions",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-x",
      }).success,
    ).toBe(true);
  });
});

describe("testProviderInput", () => {
  it("requires both id and a non-empty model", () => {
    expect(testProviderInput.safeParse({ id: "p1", model: "gpt-4o-mini" }).success).toBe(true);
    expect(testProviderInput.safeParse({ id: "p1" }).success).toBe(false);
    expect(testProviderInput.safeParse({ id: "p1", model: "" }).success).toBe(false);
  });
});

describe("provider-type metadata", () => {
  it("DEFAULT_BASE_URL covers every provider type", () => {
    expect(Object.keys(DEFAULT_BASE_URL).sort()).toEqual([...aiProviderApiType.options].sort());
    expect(DEFAULT_BASE_URL["openai-chat-completions"]).toBeNull();
    expect(DEFAULT_BASE_URL["openai-responses"]).toContain("https://");
  });
  it("PROVIDER_TYPE_LABEL covers every type with the agreed names", () => {
    expect(Object.keys(PROVIDER_TYPE_LABEL).sort()).toEqual([...aiProviderApiType.options].sort());
    expect(PROVIDER_TYPE_LABEL["openai-responses"]).toBe("OpenAI Responses");
    expect(PROVIDER_TYPE_LABEL["openai-chat-completions"]).toBe("OpenAI Chat Completions");
  });
});

describe("upsertProviderInput models field", () => {
  it("upsertProviderInput accepts optional models array", () => {
    expect(
      upsertProviderInput.safeParse({ type: "openai-responses", models: ["gpt-4o", "gpt-4o-mini"] })
        .success,
    ).toBe(true);
    expect(upsertProviderInput.safeParse({ type: "openai-responses", models: [""] }).success).toBe(
      false,
    ); // 空串非法
  });
});

describe("DeepSeek provider helpers", () => {
  it("isDeepseekProvider matches only the builtin DeepSeek", () => {
    expect(isDeepseekProvider({ label: "DeepSeek", isBuiltin: true })).toBe(true);
    expect(isDeepseekProvider({ label: "DeepSeek", isBuiltin: false })).toBe(false);
    expect(isDeepseekProvider({ label: "OpenAI", isBuiltin: true })).toBe(false);
    expect(isDeepseekProvider({ label: null, isBuiltin: true })).toBe(false);
  });
  it("resolveProviderBaseUrl derives DeepSeek per type, passes through otherwise", () => {
    const ds = { label: "DeepSeek", isBuiltin: true, baseUrl: null };
    expect(resolveProviderBaseUrl(ds, "openai-chat-completions")).toBe("https://api.deepseek.com");
    expect(resolveProviderBaseUrl(ds, "anthropic")).toBe("https://api.deepseek.com/anthropic");
    // DeepSeek 不支持的 type → null（兜底）。
    expect(resolveProviderBaseUrl(ds, "openai-responses")).toBeNull();
    // 非 DeepSeek：原样返回存储值。
    const gw = { label: "Gw", isBuiltin: false, baseUrl: "https://gw/v1" };
    expect(resolveProviderBaseUrl(gw, "openai-chat-completions")).toBe("https://gw/v1");
  });
});

describe("listModels contracts", () => {
  it("listModelsInput accepts ephemeral key and id forms", () => {
    expect(listModelsInput.safeParse({ type: "openai-responses", apiKey: "sk-x" }).success).toBe(
      true,
    );
    expect(listModelsInput.safeParse({ type: "anthropic", id: "p1" }).success).toBe(true);
    expect(listModelsInput.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("listModelsResult is a discriminated union on ok", () => {
    expect(listModelsResult.safeParse({ ok: true, models: ["a"] }).success).toBe(true);
    expect(listModelsResult.safeParse({ ok: false, message: "x", status: 401 }).success).toBe(true);
    expect(listModelsResult.safeParse({ ok: false }).success).toBe(false);
  });
});
