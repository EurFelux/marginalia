import { APICallError, LoadAPIKeyError } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAiSdkTester,
  getErrorMessage,
  mapTestError,
  type GenerateProbe,
} from "@main/secrets/ai-sdk-tester";
import { initMainI18n } from "@main/i18n";

beforeAll(() => initMainI18n("en"));

// 构造真实的 APICallError 实例，避免 duck-typing 绕过类型守卫。responseBody 可选。
const apiErr = (statusCode?: number, responseBody?: string) =>
  new APICallError({
    message: "boom",
    url: "https://api.test/v1",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });

describe("getErrorMessage", () => {
  it("extracts {error:{message}} (anthropic/openai/google shape)", () => {
    const body = JSON.stringify({ error: { type: "forbidden", message: "Request not allowed" } });
    expect(getErrorMessage(apiErr(403, body))).toBe("Request not allowed");
  });
  it("extracts {error:'string'} shape", () => {
    expect(getErrorMessage(apiErr(400, JSON.stringify({ error: "bad thing" })))).toBe("bad thing");
  });
  it("extracts top-level {message}", () => {
    expect(getErrorMessage(apiErr(400, JSON.stringify({ message: "top level" })))).toBe(
      "top level",
    );
  });
  it("returns null when body is absent", () => {
    expect(getErrorMessage(apiErr(403))).toBeNull();
  });
  it("returns null for a non-JSON body", () => {
    expect(getErrorMessage(apiErr(403, "<html>blocked</html>"))).toBeNull();
  });
  it("returns null when no readable message field", () => {
    expect(getErrorMessage(apiErr(403, JSON.stringify({ foo: "bar" })))).toBeNull();
  });
  it("returns null for a non-APICallError", () => {
    expect(getErrorMessage(new Error("x"))).toBeNull();
  });
});

describe("mapTestError", () => {
  it("surfaces the provider's real message when extractable", () => {
    const body = JSON.stringify({ error: { message: "Request not allowed" } });
    expect(mapTestError(apiErr(403, body))).toEqual({
      ok: false,
      status: 403,
      message: "Request not allowed",
    });
  });
  it("401 without body → HTTP semantics (possible direction, not a fabricated cause)", () => {
    expect(mapTestError(apiErr(401))).toEqual({
      ok: false,
      status: 401,
      message: "HTTP 401: Unauthorized — the API key may be invalid or missing",
    });
  });
  it("403 without body → states possible directions, never asserts a cause", () => {
    expect(mapTestError(apiErr(403))).toEqual({
      ok: false,
      status: 403,
      message:
        "HTTP 403: Forbidden — access denied; possibly insufficient permissions or a region/network restriction",
    });
  });
  it("404 without body → HTTP semantics", () => {
    expect(mapTestError(apiErr(404))).toEqual({
      ok: false,
      status: 404,
      message: "HTTP 404: Not Found — the model name or endpoint may be wrong",
    });
  });
  it("5xx without body → server-side error", () => {
    expect(mapTestError(apiErr(500))).toEqual({
      ok: false,
      status: 500,
      message: "HTTP 500: the provider had a server-side error",
    });
  });
  // reasoning 模型探针预算不足时，provider 回 HTTP 2xx 但响应 incomplete/无法解析，
  // AI SDK 带 statusCode=200 抛 APICallError。裸 "HTTP 200" 自相矛盾（200=成功却报失败），
  // 必须给诚实可读的诊断（响应无法解析），绝不输出误导性的成功状态码。
  it("2xx without an extractable error → explains the response could not be parsed, never bare 'HTTP 200'", () => {
    // stringMatching 既断言诚实诊断，又隐含排除了自相矛盾的裸 "HTTP 200"（不匹配该正则）。
    expect(mapTestError(apiErr(200))).toMatchObject({
      ok: false,
      status: 200,
      message: expect.stringMatching(/could not be parsed/i),
    });
  });
  it("2xx with a non-error body surfaces a parse diagnostic, not a contradictory HTTP 200", () => {
    expect(mapTestError(apiErr(200, JSON.stringify({ status: "incomplete" })))).toMatchObject({
      ok: false,
      status: 200,
      message: expect.stringMatching(/could not be parsed/i),
    });
  });
  it("LoadAPIKeyError → no key configured", () => {
    expect(mapTestError(new LoadAPIKeyError({ message: "no key" }))).toEqual({
      ok: false,
      message: "No API key configured",
    });
  });
  it("non-http error → request failed with the real exception text", () => {
    expect(mapTestError(new Error("ECONNREFUSED"))).toEqual({
      ok: false,
      message: "Request failed: ECONNREFUSED",
    });
  });
});

describe("createAiSdkTester", () => {
  it("returns ok:true when the probe succeeds", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai-responses",
      baseUrl: null,
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: true });
  });

  it("maps a probe rejection through mapTestError (surfaces real message)", async () => {
    const body = JSON.stringify({ error: { message: "Request not allowed" } });
    const probe: GenerateProbe = async () => {
      throw apiErr(403, body);
    };
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai-responses",
      baseUrl: null,
      apiKey: "bad",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: false, status: 403, message: "Request not allowed" });
  });

  it("returns ok:false when the model cannot be resolved (openai-compatible without baseUrl)", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai-chat-completions",
      baseUrl: null,
      apiKey: "sk",
      model: "x",
    });
    expect(r.ok).toBe(false);
  });
});
