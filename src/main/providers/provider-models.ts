import { z } from "zod";
import { DEFAULT_BASE_URL, type ProviderType } from "@shared/providers";

export interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/** 按 type 构造 /models 请求（url + 鉴权头）。base = baseUrl ?? 默认端点；openai-compatible 无默认必须给 base。 */
export function buildModelsRequest(
  type: ProviderType,
  baseUrl: string | null,
  apiKey: string,
): ModelsRequest {
  const raw = baseUrl ?? DEFAULT_BASE_URL[type];
  if (!raw) throw new Error("baseUrl is required for this provider");
  // baseUrl 约定：含版本路径（openai `/v1`、anthropic `/v1`、google `/v1beta`），拉模型只拼 `/models`，
  // 与 model-factory 生成路径的 baseURL 约定一致（自建代理填同一个 base 两处都对）。去尾斜杠避免 `//models`。
  const base = raw.replace(/\/+$/, "");
  switch (type) {
    case "openai":
    case "openai-compatible":
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic":
      return {
        url: `${base}/models`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      };
    case "google":
      return { url: `${base}/models?key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
}

const openaiLike = z.object({ data: z.array(z.object({ id: z.string() })) });
const googleSchema = z.object({
  models: z.array(
    z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() }),
  ),
});
const looseItem = z.object({ id: z.string() }).passthrough();

/** 先 Zod 校验外部响应（API 边界），再按 type 归一为 model id 列表。openai-compatible 放宽 best-effort。 */
export function adaptModelsResponse(type: ProviderType, json: unknown): string[] {
  if (type === "google") {
    return (
      googleSchema
        .parse(json)
        // 缺 supportedGenerationMethods 字段时默认保留（include）：宁可多列让用户试，也不静默漏掉。
        .models.filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
        .map((m) => m.name.replace(/^models\//, ""))
    );
  }
  if (type === "openai-compatible") {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data.flatMap((it) => {
      const p = looseItem.safeParse(it);
      return p.success ? [p.data.id] : [];
    });
  }
  // openai / anthropic：严格 data[].id
  return openaiLike.parse(json).data.map((m) => m.id);
}
