import { describe, expect, it } from "vitest";
import type { ProviderDto } from "@shared/providers";
import { isModelConnected, isOnboardingComplete, summaryModelBackfill } from "./onboarding-logic";

function provider(over: Partial<ProviderDto> = {}): ProviderDto {
  return {
    id: "p1",
    type: "openai-chat-completions",
    compatibleApis: ["openai-chat-completions"],
    label: "P1",
    baseUrl: "https://x",
    keyMask: "sk-…1234",
    models: ["m1"],
    isBuiltin: false,
    createdAt: 0,
    ...over,
  };
}

describe("isModelConnected", () => {
  it("false when chatModel null", () => {
    expect(isModelConnected(null, [provider()])).toBe(false);
  });
  it("false when providers undefined (query loading)", () => {
    expect(isModelConnected({ providerId: "p1", model: "m1" }, undefined)).toBe(false);
  });
  it("false when the chosen provider has no key", () => {
    expect(isModelConnected({ providerId: "p1", model: "m1" }, [provider({ keyMask: null })])).toBe(
      false,
    );
  });
  it("false when the chosen provider is missing from the list", () => {
    expect(isModelConnected({ providerId: "ghost", model: "m1" }, [provider()])).toBe(false);
  });
  it("true when provider+model selected and that provider has a key", () => {
    expect(isModelConnected({ providerId: "p1", model: "m1" }, [provider()])).toBe(true);
  });
});

describe("isOnboardingComplete", () => {
  it("requires both model connected and auto-summarize on", () => {
    expect(isOnboardingComplete(false, false)).toBe(false);
    expect(isOnboardingComplete(true, false)).toBe(false);
    expect(isOnboardingComplete(false, true)).toBe(false);
    expect(isOnboardingComplete(true, true)).toBe(true);
  });
});

describe("summaryModelBackfill", () => {
  it("returns null when summaryModel already set (don't clobber)", () => {
    expect(
      summaryModelBackfill({ providerId: "x", model: "y" }, { providerId: "p1", model: "m1" }),
    ).toBeNull();
  });
  it("returns the chat model when summaryModel unset", () => {
    expect(summaryModelBackfill(null, { providerId: "p1", model: "m1" })).toEqual({
      providerId: "p1",
      model: "m1",
    });
  });
  it("returns null when chat model not configured", () => {
    expect(summaryModelBackfill(null, null)).toBeNull();
  });
});
