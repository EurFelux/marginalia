/**
 * MCP 搜索后端：通过 Streamable HTTP MCP 协议调用远端搜索工具（Exa 等）。
 *
 * SDK API（@modelcontextprotocol/sdk 1.29.0，经 .d.ts 确认）：
 *   - new Client({ name, version }, options?)
 *   - client.connect(transport, requestOptions?)
 *   - client.callTool({ name, arguments }, resultSchema?, requestOptions?)
 *   - new StreamableHTTPClientTransport(url: URL, opts?: { requestInit?: RequestInit, ... })
 *     → requestInit.headers 传自定义请求头（含 API key）——与计划假设一致。
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "@main/logger";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";
import type { WebSearchBackendConfig } from "@shared/web-search";

const log = createLogger("search");

/** 创建 MCP 后端所需的运行时参数。 */
export interface McpBackendOpts {
  id: string;
  url: string;
  toolName: string;
  headers: Record<string, string>;
  mapResult: (raw: unknown) => SearchHit[];
}

const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";

const exaResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

/**
 * 将 MCP callTool 返回值映射为 SearchHit[]。
 *
 * 实测 Exa MCP (web_search_exa) 返回格式（structuredContent: NONE）：
 *   { content: [{ type:"text", text: <formatted plain text> }] }
 *
 * 每个结果块的文本格式（块间以 --- 分隔）：
 *   Title: <title>
 *   URL: <url>
 *   Published: <ISO 日期 | N/A>
 *   Author: <name | N/A>
 *   Highlights:
 *   <多行 highlight 文本>
 */
export function mapExaResult(raw: unknown): SearchHit[] {
  // envelope 格式校验：失败时抛出（让 SearchService 走回退路径）
  const { content } = exaResultSchema.parse(raw);
  const text = content[0]!.text;

  // 块间分隔：--- 独占一行（允许前后空白）
  const blocks = text.split(/\n[ \t]*-{3,}[ \t]*\n/);

  const hits: SearchHit[] = [];
  for (const block of blocks) {
    try {
      const titleMatch = /^Title:\s*(.+)$/m.exec(block);
      const urlMatch = /^URL:\s*(.+)$/m.exec(block);
      const publishedMatch = /^Published:\s*(.+)$/m.exec(block);
      const highlightsMatch = /^Highlights:\s*\n([\s\S]*)$/m.exec(block);

      const url = urlMatch?.[1]?.trim();
      if (!url) continue; // 无 URL，跳过此块

      const title = titleMatch?.[1]?.trim() || url;
      const publishedRaw = publishedMatch?.[1]?.trim();
      const publishedDate = publishedRaw && publishedRaw !== "N/A" ? publishedRaw : undefined;

      // highlight 文本：折叠多余空行，去首尾空白，限 600 字符
      const highlightText = highlightsMatch?.[1] ?? "";
      const snippet = highlightText
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 600);

      hits.push({ title, url, snippet, ...(publishedDate ? { publishedDate } : {}) });
    } catch {
      // 单块解析失败不影响其他块
    }
  }
  return hits;
}

/** 构造 Exa MCP 预设后端配置。apiKey 可选——Exa 免费层无 key 可用。 */
export function exaBackendOpts(apiKey?: string): McpBackendOpts {
  return {
    id: "exa-mcp",
    url: EXA_MCP_URL,
    toolName: "web_search_exa",
    headers: apiKey ? { "x-api-key": apiKey } : {},
    mapResult: mapExaResult,
  };
}

/**
 * 构造通用 MCP 后端配置（支持自定义请求头与工具名）。
 *
 * 备用 `kind:"mcp"` server 复用 `mapExaResult`，即假设其 MCP tool 返回 Exa 兼容的
 * 格式化文本（块间 ---，每块含 Title/URL/Published/Highlights 行）；
 * 返回异形结构的后端属未来扩展（spec 非目标），届时再为其特化 `mapResult`。
 */
export function genericBackendOpts(
  cfg: Extract<WebSearchBackendConfig, { kind: "mcp" }>,
): McpBackendOpts {
  const header = cfg.apiKeyHeader ?? "x-api-key";
  return {
    id: `mcp:${new URL(cfg.url).host}`,
    url: cfg.url,
    toolName: cfg.toolName,
    headers: cfg.apiKey ? { [header]: cfg.apiKey } : {},
    mapResult: mapExaResult,
  };
}

/** 根据偏好配置选取合适的 opts 构造函数。 */
export function backendOptsFor(cfg: WebSearchBackendConfig): McpBackendOpts {
  return cfg.kind === "exa-mcp" ? exaBackendOpts(cfg.apiKey) : genericBackendOpts(cfg);
}

/**
 * 创建一个惰性连接的 MCP SearchBackend。
 * 首次 search() 调用时建立连接；close() 时释放。
 */
export function makeMcpBackend(opts: McpBackendOpts): SearchBackend {
  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;

  async function ensure(): Promise<Client> {
    if (client) return client;
    if (!connecting) {
      connecting = (async () => {
        try {
          const c = new Client({ name: "marginalia", version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
            requestInit: { headers: opts.headers },
          });
          await c.connect(transport);
          client = c;
          return c;
        } finally {
          connecting = undefined;
        }
      })();
    }
    return connecting;
  }

  return {
    id: opts.id,
    async search(query, { numResults }) {
      const c = await ensure();
      const raw = await c.callTool({
        name: opts.toolName,
        arguments: { query, ...(numResults != null ? { numResults } : {}) },
      });
      return opts.mapResult(raw);
    },
    async close() {
      if (client) {
        try {
          await client.close();
        } catch (err) {
          log.warn(`mcp backend ${opts.id} close failed`, err);
        }
        client = undefined;
      }
    },
  };
}
