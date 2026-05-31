import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderType } from "@shared/providers";

/**
 * AI SDK 语言模型实例类型（由 provider 工厂返回；四家结构一致，可喂 generateText/streamText）。
 * 经 OpenAIProvider 的调用签名解析为 `@ai-sdk/provider` 的 `LanguageModelV3`。若某次 `@ai-sdk/openai`
 * 大版本升级导致该类型漂移，改为直接 `import type { LanguageModelV3 } from "@ai-sdk/provider"` 更稳。
 */
export type ChatModel = ReturnType<ReturnType<typeof createOpenAI>>;

export interface ResolveModelParams {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string;
  model: string;
}

/** 把 (provider 配置 + 模型名) 解析为 AI SDK 语言模型。MA3 测连接与 MA4 对话共用此工厂。 */
export function resolveLanguageModel(p: ResolveModelParams): ChatModel {
  const withBase = (base: string | null) => (base ? { baseURL: base } : {});
  switch (p.type) {
    case "openai":
      return createOpenAI({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "openai-compatible":
      if (!p.baseUrl) throw new Error("openai-compatible provider requires a baseUrl");
      return createOpenAICompatible({
        name: "openai-compatible",
        apiKey: p.apiKey,
        baseURL: p.baseUrl,
      })(p.model);
  }
}
