import { z } from "zod";
import { DEFAULT_BASE_URL, type AiProviderApiType } from "@shared/providers";
import { t } from "@main/i18n";

export interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/** 按 type 构造 /models 请求（url + 鉴权头）。base = baseUrl ?? 默认端点；openai-compatible 无默认必须给 base。 */
export function buildModelsRequest(
  type: AiProviderApiType,
  baseUrl: string | null,
  apiKey: string,
): ModelsRequest {
  const raw = baseUrl ?? DEFAULT_BASE_URL[type];
  if (!raw) throw new Error(t("errors.baseUrlRequiredForProvider", "该 provider 需要 baseUrl"));
  // baseUrl 约定：含版本路径（openai `/v1`、anthropic `/v1`、google `/v1beta`），拉模型只拼 `/models`，
  // 与 model-factory 生成路径的 baseURL 约定一致（自建代理填同一个 base 两处都对）。去尾斜杠避免 `//models`。
  const base = raw.replace(/\/+$/, "");
  switch (type) {
    case "openai-responses":
    case "openai-chat-completions":
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic":
      return {
        url: `${base}/models`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      };
    case "google-generate-content":
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

/**
 * 非文本生成模型的 id 片段（图像 dall-e/gpt-image、语音合成 tts、语音转写 whisper/transcribe、
 * 向量 embed、重排 rerank、审核 moderation、视频 sora）——这些不能用于对话/文本生成，从拉取结果剔除。
 * 用 `(^|[-/])…` 词界匹配，避免误伤恰好含相同子串的对话模型；只剔确信项、未知一律保留
 * （honest：宁可多列让用户自行取舍，绝不静默漏掉可用模型）。google 走 generateContent 能力过滤，不经此名单。
 */
const NON_TEXT_MODEL =
  /(^|[-/])(dall-e|gpt-image|tts|whisper|transcribe|embed|rerank|moderation|sora)/i;

/** 从 model id 列表剔除明确的非文本生成模型（见 NON_TEXT_MODEL）。 */
function filterTextModels(ids: string[]): string[] {
  return ids.filter((id) => !NON_TEXT_MODEL.test(id));
}

export interface FetchModelsParams {
  type: AiProviderApiType;
  baseUrl: string | null;
  apiKey: string;
}

/** HTTP 状态码标准语义兜底（标「可能方向」，绝不编造）；与 ai-sdk-tester 同款。 */
const HTTP_HINT: Record<number, string> = {
  400: "Bad Request — the request may be rejected",
  401: "Unauthorized — the API key may be invalid or missing",
  403: "Forbidden — access denied",
  404: "Not Found — the endpoint or base URL may be wrong",
  429: "Too Many Requests — rate limited or quota exhausted",
};

/** 把抛出/非 2xx 响应映射为可读 message（优先透传 provider 原文，提不到退 HTTP 语义）。 */
export function mapModelsError(
  err: unknown,
  status: number | undefined,
): { status?: number; message: string } {
  // 仅取 Error.message / string 原文（避免对任意 unknown 调 String 得到 "[object Object]"）；
  // 其它形态（对象/数字等）退到 HTTP 语义——honest，不编造。
  const fromErr = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (fromErr) return { status, message: fromErr };
  if (status && HTTP_HINT[status])
    return { status, message: `HTTP ${status}: ${HTTP_HINT[status]}` };
  if (status && status >= 500)
    return { status, message: `HTTP ${status}: the provider had a server-side error` };
  if (status) return { status, message: `HTTP ${status}` };
  return { message: t("errors.requestFailed", "请求失败") };
}

/** 从错误响应体尽力提真实 message（{error:{message}} / {error:"str"} / {message}）；提不到返 null。 */
function extractBodyMessage(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const e = o.error;
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (typeof o.message === "string" && o.message.trim()) return o.message;
  return null;
}

/** 调 provider /models 端点 → model id 列表。失败抛 Error（message 已透传 provider 原文或 HTTP 语义）。 */
export async function fetchProviderModels(
  p: FetchModelsParams,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const req = buildModelsRequest(p.type, p.baseUrl, p.apiKey);
  const res = await fetchImpl(req.url, { method: "GET", headers: req.headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = extractBodyMessage(body) ?? mapModelsError(undefined, res.status).message;
    throw new Error(message);
  }
  return adaptModelsResponse(p.type, body);
}

/** 先 Zod 校验外部响应（API 边界），再按 type 归一为 model id 列表。openai-chat-completions 放宽 best-effort。 */
export function adaptModelsResponse(type: AiProviderApiType, json: unknown): string[] {
  if (type === "google-generate-content") {
    return (
      googleSchema
        .parse(json)
        // 缺 supportedGenerationMethods 字段时默认保留（include）：宁可多列让用户试，也不静默漏掉。
        .models.filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
        .map((m) => m.name.replace(/^models\//, ""))
    );
  }
  if (type === "openai-chat-completions") {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const ids = data.flatMap((it) => {
      const p = looseItem.safeParse(it);
      return p.success ? [p.data.id] : [];
    });
    return filterTextModels(ids);
  }
  // openai-responses / anthropic：严格 data[].id
  return filterTextModels(openaiLike.parse(json).data.map((m) => m.id));
}
