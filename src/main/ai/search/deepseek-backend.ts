/**
 * DeepSeek 联网后端：直连 DeepSeek Search / Fetch REST API（https://api-docs.deepseek.com/guides/search/），
 * 同时提供 search 与 fetchPage。key 复用内置 DeepSeek provider、fetch 用出站 net.fetch，均由胶水层注入
 * （spec 2026-10-17-deepseek-web-backend-design §5.3）。
 */
import { z } from "zod";
import { createLogger } from "@main/logger";
import type { FetchedPage, SearchBackend, SearchHit } from "@main/ai/search/types";

const log = createLogger("search");

const DEEPSEEK_TOOLS_URL = "https://api.deepseek.com/v1/tools";
/** DeepSeek Search 的 query 上限（Unicode 码点，API 硬限制）。 */
export const DEEPSEEK_SEARCH_QUERY_MAX = 128;
const DEEPSEEK_REQUEST_TIMEOUT_MS = 30_000;

// 外部 API 形状：边界校验放本模块，不入 @shared。文档标为可空的字段一律 nullish。
const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string().nullish(),
      snippet: z.string().nullish(),
      summary: z.string().nullish(),
      date: z.string().nullish(),
    }),
  ),
});
const fetchResponseSchema = z.object({
  title: z.string().nullish(),
  content: z.string(),
});
const errorResponseSchema = z.object({ error: z.object({ message: z.string() }) });

/**
 * 把 Search API 返回映射为 SearchHit[]：snippet 取面向模型的长摘要 summary（空则退回 snippet），
 * 无 url 的条目跳过；保持接口返回的 rerank 顺序。形状不符时抛错（等同该后端失败，触发回退）。
 */
export function mapDeepseekResults(raw: unknown): SearchHit[] {
  const { results } = searchResponseSchema.parse(raw);
  return results.flatMap((r) =>
    r.url
      ? [
          {
            title: r.title || r.url,
            url: r.url,
            snippet: r.summary || r.snippet || "",
            ...(r.date ? { publishedDate: r.date } : {}),
          },
        ]
      : [],
  );
}

/** 从错误响应体里取 OpenAI 兼容格式的 error.message；取不到就用截断的原文或状态文本。 */
function errorMessage(body: string, statusText: string): string {
  try {
    const parsed = errorResponseSchema.safeParse(JSON.parse(body));
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // 非 JSON 响应体：退回原文
  }
  return body.trim().slice(0, 200) || statusText;
}

export interface DeepseekBackendOpts {
  /** 内置 DeepSeek provider 的 key；未配置时每次调用立即抛错（不发请求），由 SearchService 回退。 */
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
}

export function makeDeepseekBackend(opts: DeepseekBackendOpts): SearchBackend {
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function post(
    endpoint: "search" | "fetch",
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (!opts.apiKey) {
      throw new Error("DeepSeek API key is not configured (Settings → Models → DeepSeek)");
    }
    const timeout = AbortSignal.timeout(DEEPSEEK_REQUEST_TIMEOUT_MS);
    const res = await doFetch(`${DEEPSEEK_TOOLS_URL}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `DeepSeek ${endpoint} failed (HTTP ${res.status}): ${errorMessage(text, res.statusText)}`,
      );
    }
    return res.json();
  }

  return {
    id: "deepseek",
    async search(query, { numResults, signal }) {
      const chars = Array.from(query);
      if (chars.length > DEEPSEEK_SEARCH_QUERY_MAX) {
        log.warn(
          `deepseek query truncated from ${chars.length} to ${DEEPSEEK_SEARCH_QUERY_MAX} chars`,
        );
      }
      const raw = await post(
        "search",
        {
          query: chars.slice(0, DEEPSEEK_SEARCH_QUERY_MAX).join(""),
          ...(numResults != null ? { count: numResults } : {}),
        },
        signal,
      );
      return mapDeepseekResults(raw);
    },
    async fetchPage(url, { signal }): Promise<FetchedPage> {
      const { title, content } = fetchResponseSchema.parse(await post("fetch", { url }, signal));
      return { title: title ?? "", content };
    },
    async close() {
      // 无状态 HTTP，无连接可释放
    },
  };
}
