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

// NOTE: EXA_CONTENT shape (callTool 返回 { content: [{ type:"text", text: JSON }] }) 和
// 入参名（query / numResults）来自 Exa MCP 文档推断，将在后续 smoke 任务中对真实调用校验。
const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";

const exaResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

const exaPayloadSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().default(""),
      url: z.string(),
      text: z.string().default(""),
      snippet: z.string().optional(),
      publishedDate: z.string().optional(),
    }),
  ),
});

/**
 * 将 Exa MCP callTool 返回值映射为 SearchHit[]。
 * 格式假设来自 Exa 文档，将在 smoke 阶段对真实响应校验。
 */
export function mapExaResult(raw: unknown): SearchHit[] {
  const { content } = exaResultSchema.parse(raw);
  const payload = exaPayloadSchema.parse(JSON.parse(content[0]!.text));
  return payload.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet ?? r.text,
    ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
  }));
}

/** 构造 Exa MCP 预设后端配置。 */
export function exaBackendOpts(apiKey: string): McpBackendOpts {
  return {
    id: "exa-mcp",
    url: EXA_MCP_URL,
    toolName: "web_search_exa",
    headers: { "x-api-key": apiKey },
    mapResult: mapExaResult,
  };
}

/** 构造通用 MCP 后端配置（支持自定义请求头与工具名）。 */
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

  async function ensure(): Promise<Client> {
    if (client) return client;
    const c = new Client({ name: "marginalia", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: opts.headers },
    });
    await c.connect(transport);
    client = c;
    return c;
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
