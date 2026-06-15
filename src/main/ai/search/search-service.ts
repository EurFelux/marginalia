import { createLogger } from "@main/logger";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";

const log = createLogger("search");

/**
 * 搜索服务：按顺序依次调用 backends，第一个成功即返回结果；
 * 全部失败时抛出聚合错误，由调用方（web_search tool）转换为软失败 result。
 */
export class SearchService {
  constructor(private readonly backends: SearchBackend[]) {}

  async search(query: string, opts: { numResults?: number }): Promise<SearchHit[]> {
    let lastErr: unknown;
    for (const b of this.backends) {
      try {
        return await b.search(query, opts);
      } catch (err) {
        lastErr = err;
        log.warn(`search backend ${b.id} failed, falling back`, err);
      }
    }
    throw new Error("all web search backends failed", { cause: lastErr });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.close()));
  }
}
