import { APICallError, LoadAPIKeyError, generateText } from "ai";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";
import type { ProviderTestParams, ProviderTester } from "@main/secrets/tester";
import type { TestResult } from "@shared/providers";

/** 对给定模型发一次最小生成；成功即返回，失败即抛出。可注入用于测试。 */
export type GenerateProbe = (model: ChatModel) => Promise<void>;

const realProbe: GenerateProbe = async (model) => {
  // maxOutputTokens:1 把成本压到最低；连通性以 HTTP 往返是否成功为准。
  await generateText({ model, prompt: "ping", maxOutputTokens: 1, maxRetries: 0 });
};

/**
 * 尽力从 provider 的错误响应体里提取**真实** error message。
 * 覆盖常见形状（anthropic/openai/google 等的 `{error:{message}}`、`{error:"str"}`、`{message}`）；
 * 结构未知、非 JSON、或无可读 message 字段时返回 `null`——交由调用方退到 HTTP 语义，**绝不编造原因**。
 */
export function getErrorMessage(err: unknown): string | null {
  if (!APICallError.isInstance(err) || typeof err.responseBody !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.responseBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const error = obj.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error !== null && typeof error === "object") {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  return null;
}

/** 提取不到 provider 原文时的兜底：用 HTTP 状态码的**标准语义**，明确是「可能方向」而非断言。 */
const HTTP_HINT: Record<number, string> = {
  400: "Bad Request — the request or model name may be rejected",
  401: "Unauthorized — the API key may be invalid or missing",
  403: "Forbidden — access denied; possibly insufficient permissions or a region/network restriction",
  404: "Not Found — the model name or endpoint may be wrong",
  429: "Too Many Requests — rate limited or quota exhausted",
};

function describeFallback(status: number | undefined, err: unknown): string {
  if (status === undefined) {
    // 非 HTTP 响应（网络层/解析失败等）——透传真实异常文案，不编。
    return `Request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (HTTP_HINT[status]) return `HTTP ${status}: ${HTTP_HINT[status]}`;
  if (status >= 500) return `HTTP ${status}: the provider had a server-side error`;
  return `HTTP ${status}`;
}

/**
 * 把异常映射为 TestResult。原则：**优先透传 provider 的真实 error message**；
 * 提取不到才退到 HTTP 状态码的标准语义（明确「可能方向」），**绝不虚构具体原因**。
 */
export function mapTestError(err: unknown): TestResult {
  if (LoadAPIKeyError.isInstance(err)) {
    return { ok: false, message: "No API key configured" };
  }
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;
  return { ok: false, status, message: getErrorMessage(err) ?? describeFallback(status, err) };
}

/** 基于 AI SDK generateText 的真实 ProviderTester。probe 可注入用于测试。 */
export function createAiSdkTester(probe: GenerateProbe = realProbe): ProviderTester {
  return {
    async test(params: ProviderTestParams): Promise<TestResult> {
      let model: ChatModel;
      try {
        model = resolveLanguageModel(params);
      } catch (err) {
        console.warn("[providers] testProvider: model resolution failed:", err);
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      try {
        await probe(model);
        return { ok: true };
      } catch (err) {
        return mapTestError(err);
      }
    },
  };
}

/** 进程级单例（main 胶水层注入仓库）。 */
export const aiSdkTester: ProviderTester = createAiSdkTester();
