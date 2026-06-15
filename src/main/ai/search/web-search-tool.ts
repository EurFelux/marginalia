import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "@main/logger";
import { SearchService } from "@main/ai/search/search-service";
import { makeMcpBackend, backendOptsFor } from "@main/ai/search/mcp-backend";
import type { WebSearchConfig } from "@shared/web-search";

const log = createLogger("search");

/**
 * 软失败包装：execute 抛错会中断整条流式回复；转 { error } result 后进入对话流，
 * 模型可据错误信息换参重试（与 src/main/ai/tools.ts runTool 同一约定）。
 */
async function runTool<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`tool ${name} failed (error returned to model for self-correction)`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 创建 web_search 工具实例。
 * @param service 搜索服务（注入，便于测试）
 * @param turnEnabled 本轮是否允许联网搜索；false 时立即软失败，不调用 service
 */
export function makeWebSearchTool(service: SearchService, turnEnabled: boolean) {
  return tool({
    description:
      "Search the web for current or external information not contained in the book " +
      "(recent events, facts beyond the text, background). Returns ranked results " +
      "with title, url and snippet.",
    inputSchema: z.object({
      query: z.string().min(1),
      numResults: z.number().int().min(1).max(10).optional(),
    }),
    execute: ({ query, numResults }) =>
      runTool("web_search", async () => {
        if (!turnEnabled) {
          throw new Error(
            "Web search is turned off for this message. Answer from available context, or tell the user to enable web search for this message.",
          );
        }
        const results = await service.search(query, { numResults });
        return { results };
      }),
  });
}

/**
 * 根据联网搜索偏好配置创建工具集与资源清理函数。
 * 调用方负责在 AI 流结束后调用 close() 释放 MCP 连接。
 */
export function createSearchTools(cfg: WebSearchConfig, turnEnabled: boolean) {
  const backends = cfg.backends
    .filter((b) => b.enabled !== false)
    .map((b) => makeMcpBackend(backendOptsFor(b)));
  const service = new SearchService(backends);
  return {
    tools: { web_search: makeWebSearchTool(service, turnEnabled) },
    close: () => service.close(),
  };
}
