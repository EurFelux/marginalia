import { describe, expect, it } from "vitest";
import { createProvider } from "@main/providers/provider-factory";
import type { ProviderRow } from "@main/providers/repository";

function row(over: Partial<ProviderRow>): ProviderRow {
  return {
    id: "p1",
    type: "openai-chat-completions",
    compatibleApis: null,
    label: null,
    baseUrl: null,
    apiKeyEncrypted: null,
    models: null,
    isBuiltin: false,
    createdAt: 0,
    ...over,
  };
}

describe("createProvider", () => {
  it("derives DeepSeek baseUrl from the row's type (db baseUrl is null)", () => {
    const cc = createProvider(
      row({ label: "DeepSeek", isBuiltin: true, type: "openai-chat-completions" }),
    );
    expect(cc.baseUrl).toBe("https://api.deepseek.com");
    const an = createProvider(row({ label: "DeepSeek", isBuiltin: true, type: "anthropic" }));
    expect(an.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("passes through the stored baseUrl for non-DeepSeek providers", () => {
    expect(createProvider(row({ baseUrl: "https://gw/v1" })).baseUrl).toBe("https://gw/v1");
    // 同名但非内置 → 不算 DeepSeek，baseUrl 照原样（null）。
    expect(createProvider(row({ label: "DeepSeek", isBuiltin: false })).baseUrl).toBeNull();
  });
});
