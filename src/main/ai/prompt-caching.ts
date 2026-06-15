// src/main/ai/prompt-caching.ts
import type { ModelMessage, SystemModelMessage } from "ai";
import type { AiProviderApiType } from "@shared/providers";

/**
 * Prompt caching 抽象。各 provider 缓存语义分两类：
 * - **显式断点型**——Anthropic 家族（first-party / Bedrock / Vertex）无 implicit cache，必须用
 *   providerOptions 标 cache_control / cachePoint 断点（前缀逐字节匹配，断点之后随前缀变化失效）。
 * - **隐式型**——OpenAI Responses、OpenAI-compatible（含 DeepSeek）、Gemini 2.5 等由服务端自动
 *   缓存长前缀，无需标记。
 *
 * 故把「断点放哪」(provider 无关的布局) 与「断点怎么标」(provider 专属 marker) 解耦：布局策略由
 * {@link breakpointStrategy} 共享，各 provider 仅在 {@link STRATEGIES} 声明自己的 marker；隐式型
 * 不注册、原样透传。纯函数，无 Electron/网络依赖，可单测。
 */

type CacheProviderOptions = NonNullable<SystemModelMessage["providerOptions"]>;

export interface CachingInput {
  providerType: AiProviderApiType | undefined;
  system: string | undefined;
  messages: ModelMessage[];
}

export interface CachingResult {
  /** 可作为 streamText 的 system 参数：显式断点型会升级为带 providerOptions 的 SystemModelMessage。 */
  system: string | SystemModelMessage | undefined;
  messages: ModelMessage[];
}

/** 一种缓存策略：给定 system + messages，返回（可能已插入断点的）system + messages。 */
export type CachingStrategy = (args: {
  system: string | undefined;
  messages: ModelMessage[];
}) => CachingResult;

/**
 * 显式前缀缓存的**共享布局**（provider 无关）：
 * - system 一个**固定**断点——渲染序 tools→system→messages，连 tools 一起进缓存，跨轮、（base
 *   prompt 相同时）跨会话复用；走 streamText 的 `system` 参数（传 SystemModelMessage 即可携带
 *   providerOptions，且不触发 allowSystemInMessages 警告）。
 * - 末两个 user 轮各一个**滚动**断点——随对话增长滚动，借 20-block lookback 让上一轮仍命中。
 *
 * 共 ≤3 断点（在各家 4 上限内）。`marker` 是 provider 专属的 providerOptions——Anthropic 传
 * `{ anthropic: { cacheControl: ... } }`，将来 Bedrock 可传 `{ bedrock: { cachePoint: ... } }`，
 * 布局逻辑不变。
 */
export function breakpointStrategy(marker: CacheProviderOptions): CachingStrategy {
  return ({ system, messages }) => {
    const taggedSystem: string | SystemModelMessage | undefined =
      system != null ? { role: "system", content: system, providerOptions: marker } : undefined;

    const out = [...messages];
    const userIndices = out.flatMap((m, i) => (m.role === "user" ? [i] : []));
    for (const i of userIndices.slice(-2)) {
      const m = out[i];
      out[i] = { ...m, providerOptions: { ...m.providerOptions, ...marker } } as ModelMessage;
    }
    return { system: taggedSystem, messages: out };
  };
}

/**
 * provider → 显式缓存策略。缺席者（OpenAI Responses / OpenAI-compatible / Gemini）依赖服务端
 * **隐式缓存**，{@link withPromptCaching} 原样透传。新增显式断点型 provider 在此注册一行即可。
 */
const STRATEGIES: Partial<Record<AiProviderApiType, CachingStrategy>> = {
  anthropic: breakpointStrategy({ anthropic: { cacheControl: { type: "ephemeral" } } }),
};

/** 按 provider 应用其缓存策略；无显式策略者原样返回（隐式缓存）。stream-assistant 在 streamText 前调用。 */
export function withPromptCaching(input: CachingInput): CachingResult {
  const strategy = input.providerType ? STRATEGIES[input.providerType] : undefined;
  if (!strategy) return { system: input.system, messages: input.messages };
  return strategy({ system: input.system, messages: input.messages });
}
