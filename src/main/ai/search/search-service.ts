import { createLogger } from "@main/logger";
import type { FetchedPage, SearchBackend, SearchHit } from "@main/ai/search/types";

const log = createLogger("search");

/**
 * 搜索服务：按顺序依次调用 backends，第一个成功即返回结果；
 * 全部失败时抛出聚合错误，由调用方（web_search / web_fetch tool）转换为软失败 result。
 */
export class SearchService {
  constructor(private readonly backends: SearchBackend[]) {}

  search(query: string, opts: { numResults?: number; signal?: AbortSignal }): Promise<SearchHit[]> {
    return this.firstSuccess(this.backends, (b) => b.search(query, opts));
  }

  /** 读取网页：只遍历实现了 fetchPage 的后端，回退语义同 search。 */
  fetchPage(url: string, opts: { signal?: AbortSignal }): Promise<FetchedPage> {
    const capable = this.backends.filter((b) => b.fetchPage);
    if (capable.length === 0) {
      return Promise.reject(new Error("no enabled web backend can fetch pages"));
    }
    return this.firstSuccess(capable, (b) => b.fetchPage!(url, opts));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.close()));
  }

  /**
   * 聚合错误信息带上最后一个后端的错误信息：runTool 只把 message 交给模型，
   * 模型据此自纠（如 web_fetch 遇 404 换一个 URL）。
   */
  private async firstSuccess<T>(
    backends: SearchBackend[],
    call: (b: SearchBackend) => Promise<T>,
  ): Promise<T> {
    let lastErr: unknown;
    for (const b of backends) {
      try {
        return await call(b);
      } catch (err) {
        lastErr = err;
        log.warn(`search backend ${b.id} failed, falling back`, err);
      }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`all web search backends failed: ${reason}`, { cause: lastErr });
  }
}
