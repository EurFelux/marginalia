import { APICallError, LoadAPIKeyError } from "ai";
import { describe, expect, it } from "vitest";
import { createAiSdkTester, mapTestError, type GenerateProbe } from "@main/secrets/ai-sdk-tester";

// 构造真实的 APICallError 实例，避免 duck-typing 绕过类型守卫。
const apiErr = (statusCode?: number) =>
  new APICallError({
    message: "boom",
    url: "https://api.test/v1",
    requestBodyValues: {},
    statusCode,
  });

describe("mapTestError", () => {
  it("401 → invalid key", () => {
    expect(mapTestError(apiErr(401))).toEqual({
      ok: false,
      status: 401,
      message: "Invalid API key",
    });
  });
  it("403 → invalid key (same as 401)", () => {
    expect(mapTestError(apiErr(403))).toEqual({
      ok: false,
      status: 403,
      message: "Invalid API key",
    });
  });
  it("404 → model/endpoint not found", () => {
    expect(mapTestError(apiErr(404))).toEqual({
      ok: false,
      status: 404,
      message: "Model or endpoint not found",
    });
  });
  it("500 → generic http error", () => {
    expect(mapTestError(apiErr(500))).toEqual({
      ok: false,
      status: 500,
      message: "Provider returned HTTP 500",
    });
  });
  it("LoadAPIKeyError → API key is missing or invalid", () => {
    expect(mapTestError(new LoadAPIKeyError({ message: "no key" }))).toEqual({
      ok: false,
      message: "API key is missing or invalid",
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
      throw apiErr(401);
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
