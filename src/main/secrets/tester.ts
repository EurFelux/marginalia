import type { ResolveModelParams } from "@main/ai/model-factory";
import type { TestResult } from "@shared/providers";

/** 测试连接所需参数 = 解析模型所需参数（"测试" 即解析模型 + 发一次最小生成），单一来源避免漂移。 */
export type ProviderTestParams = ResolveModelParams;

/** Provider 连通性测试端口：真实实现走网络（generateText），单测注入 fake。 */
export interface ProviderTester {
  test(params: ProviderTestParams): Promise<TestResult>;
}
