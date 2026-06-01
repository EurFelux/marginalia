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

/**
 * 进程级注入的 fetch。主进程启动时注入 Electron `net.fetch`（经 Chromium 网络栈、**默认采用系统代理**），
 * 使所有 provider 出站请求默认走系统代理。未注入（如 headless 测试）则各 SDK 回退全局 fetch。
 * 模块级单点注入而非逐调用透传：fetch 是横切传输关切，且本工厂是 test/send 两路的唯一模型出口。
 */
let injectedFetch: typeof globalThis.fetch | undefined;

/** 由主进程胶水层在 app ready 后调用一次（传 undefined 可复位，便于测试）。 */
export function setModelFetch(fetchImpl: typeof globalThis.fetch | undefined): void {
  injectedFetch = fetchImpl;
}

/** 把 (provider 配置 + 模型名) 解析为 AI SDK 语言模型。MA3 测连接与 MA4 对话共用此工厂。 */
export function resolveLanguageModel(p: ResolveModelParams): ChatModel {
  const withBase = (base: string | null) => (base ? { baseURL: base } : {});
  const fetch = injectedFetch;
  switch (p.type) {
    case "openai":
      return createOpenAI({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "openai-compatible":
      if (!p.baseUrl) throw new Error("openai-compatible provider requires a baseUrl");
      return createOpenAICompatible({
        name: "openai-compatible",
        apiKey: p.apiKey,
        fetch,
        baseURL: p.baseUrl,
      })(p.model);
  }
}
