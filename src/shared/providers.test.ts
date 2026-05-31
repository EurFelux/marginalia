import { describe, expect, it } from "vitest";
import { testProviderInput, upsertProviderInput } from "@shared/providers";

describe("upsertProviderInput", () => {
  it("accepts a minimal create (type only)", () => {
    expect(upsertProviderInput.safeParse({ type: "openai" }).success).toBe(true);
  });

  it("rejects an unknown provider type", () => {
    expect(upsertProviderInput.safeParse({ type: "cohere" }).success).toBe(false);
  });

  it("requires baseUrl for openai-compatible", () => {
    const r = upsertProviderInput.safeParse({ type: "openai-compatible" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("baseUrl"))).toBe(true);
  });

  it("accepts openai-compatible when baseUrl is provided", () => {
    expect(
      upsertProviderInput.safeParse({
        type: "openai-compatible",
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
