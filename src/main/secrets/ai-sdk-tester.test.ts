import { describe, expect, it } from "vitest";
import { createAiSdkTester, mapTestError, type GenerateProbe } from "@main/secrets/ai-sdk-tester";

describe("mapTestError", () => {
  it("401 → invalid key", () => {
    expect(mapTestError({ statusCode: 401 })).toEqual({
      ok: false,
      status: 401,
      message: "Invalid API key",
    });
  });
  it("403 → invalid key (same as 401)", () => {
    expect(mapTestError({ statusCode: 403 })).toEqual({
      ok: false,
      status: 403,
      message: "Invalid API key",
    });
  });
  it("404 → model/endpoint not found", () => {
    expect(mapTestError({ statusCode: 404 })).toEqual({
      ok: false,
      status: 404,
      message: "Model or endpoint not found",
    });
  });
  it("500 → generic http error", () => {
    expect(mapTestError({ statusCode: 500 })).toEqual({
      ok: false,
      status: 500,
      message: "Provider returned HTTP 500",
    });
  });
  it("non-http error → connection failed", () => {
    expect(mapTestError(new Error("ECONNREFUSED"))).toEqual({
      ok: false,
      message: "Connection failed: ECONNREFUSED",
    });
  });
});

describe("createAiSdkTester", () => {
  it("returns ok:true when the probe succeeds", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai",
      baseUrl: null,
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: true });
  });

  it("maps a probe rejection through mapTestError", async () => {
    const probe: GenerateProbe = async () => {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    };
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai",
      baseUrl: null,
      apiKey: "bad",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: false, status: 401, message: "Invalid API key" });
  });

  it("returns ok:false when the model cannot be resolved (openai-compatible without baseUrl)", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai-compatible",
      baseUrl: null,
      apiKey: "sk",
      model: "x",
    });
    expect(r.ok).toBe(false);
  });
});
