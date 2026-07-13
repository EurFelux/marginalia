import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { AiProviderApiType } from "@shared/providers";

/**
 * AI SDK 语言模型实例类型：四家 provider 工厂均返回 `@ai-sdk/provider` 的 `LanguageModelV4`
 * （可喂 generateText/streamText）。直接依赖该接口，不再经 `@ai-sdk/openai` 的返回类型推导，免大版本漂移。
 */
export type ChatModel = LanguageModelV4;

export interface ResolveModelParams {
  type: AiProviderApiType;
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

/**
 * provider 是否支持图像 tool result（file-data content part；spec §7 门控）。
 * openai-chat-completions 的 tool 消息只收纯文本（@ai-sdk/openai-compatible 不处理 file-data）；
 * 其余三家 SDK 均转换 file-data → 各自原生图像格式（对各包 dist 实证）。
 * undefined（测试 mock 未注入 providerType）按不支持处理——保守但 honest。
 * 刻意不做「模型是否视觉」启发式白名单：白名单必漏新视觉模型而静默剥夺能力（对齐
 * provider-models.ts「未知一律保留」原则）；误调 image 的失败以真实错误流回，模型自会改用 text。
 */
export function supportsImageToolResults(type?: AiProviderApiType): boolean {
  return type === "anthropic" || type === "google-generate-content" || type === "openai-responses";
}

/**
 * 某 provider 在每次 streamText/generateText 调用时应附带的 providerOptions（无则 undefined）。
 *
 * openai-responses → 强制 `store: false`。第三方中转/网关多为无状态、不持久化 Responses API 的
 * reasoning item（`rs_…`）。AI SDK 默认 `store: true`（@ai-sdk/openai dist:4871），多步工具循环里
 * 会把上一步 reasoning 以 `{ type: "item_reference", id: "rs_…" }` 回传（dist:2841/2890），在无状态
 * 端点上引用失效 → 「Item with id 'rs_…' not found. Items are not persisted when store is set to
 * false」。设 `store: false` 后 AI SDK 改走 encrypted_content 内联回传（reasoning 模型自动 include
 * `reasoning.encrypted_content`，dist:4906；端点未返回 encrypted_content 的裸 reasoning 会被过滤而非
 * 崩溃，dist:3331），故无状态端点也能跑完工具循环。官方 OpenAI 同样支持该路径。
 */
export function providerCallOptions(type?: AiProviderApiType): SharedV4ProviderOptions | undefined {
  if (type === "openai-responses") return { openai: { store: false } };
  return undefined;
}

/** 把 (provider 配置 + 模型名) 解析为 AI SDK 语言模型。MA3 测连接与 MA4 对话共用此工厂。 */
export function resolveLanguageModel(p: ResolveModelParams): ChatModel {
  const withBase = (base: string | null) => (base ? { baseURL: base } : {});
  const fetch = injectedFetch;
  switch (p.type) {
    case "openai-responses":
      return createOpenAI({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "google-generate-content":
      return createGoogleGenerativeAI({ apiKey: p.apiKey, fetch, ...withBase(p.baseUrl) })(p.model);
    case "openai-chat-completions":
      if (!p.baseUrl) throw new Error("openai-chat-completions provider requires a baseUrl");
      return createOpenAICompatible({
        name: "openai-chat-completions",
        apiKey: p.apiKey,
        fetch,
        baseURL: p.baseUrl,
      })(p.model);
  }
}
