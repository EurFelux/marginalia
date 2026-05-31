import { generateText } from "ai";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";
import type { ProviderTestParams, ProviderTester } from "@main/secrets/tester";
import type { TestResult } from "@shared/providers";

/** 对给定模型发一次最小生成；成功即返回，失败即抛出。可注入用于测试。 */
export type GenerateProbe = (model: ChatModel) => Promise<void>;

const realProbe: GenerateProbe = async (model) => {
  // maxOutputTokens:1 把成本压到最低；个别模型（如强制思考预算的）可能因 token 过小报错——
  // 此时视作连接失败（mapTestError 会按 statusCode 归类）。连通性以 HTTP 往返是否成功为准。
  await generateText({ model, prompt: "ping", maxOutputTokens: 1, maxRetries: 0 });
};

/** 把异常映射为 TestResult（读 statusCode；AI SDK APICallError 即带此字段）。 */
export function mapTestError(err: unknown): TestResult {
  const status =
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : undefined;
  if (status === 401 || status === 403) return { ok: false, status, message: "Invalid API key" };
  if (status === 404) return { ok: false, status, message: "Model or endpoint not found" };
  if (status !== undefined)
    return { ok: false, status, message: `Provider returned HTTP ${status}` };
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, message: `Connection failed: ${message}` };
}

/** 基于 AI SDK generateText 的真实 ProviderTester。probe 可注入用于测试。 */
export function createAiSdkTester(probe: GenerateProbe = realProbe): ProviderTester {
  return {
    async test(params: ProviderTestParams): Promise<TestResult> {
      let model: ChatModel;
      try {
        model = resolveLanguageModel(params);
      } catch (err) {
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
