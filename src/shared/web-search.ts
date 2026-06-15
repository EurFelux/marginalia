import { z } from "zod";

/** 单个搜索后端配置（判别联合）。exa-mcp = Exa 预设；mcp = 任意 streamable-HTTP MCP 搜索 server。 */
export const webSearchBackend = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exa-mcp"),
    label: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp"),
    label: z.string().optional(),
    url: z.string().url(),
    toolName: z.string().min(1),
    apiKeyHeader: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
]);
export type WebSearchBackendConfig = z.infer<typeof webSearchBackend>;

/** 联网搜索偏好：backends 顺序 = 回退优先级（工具注册由 backends.length 决定，per-message 开关走 webSearchEnabled 偏好）。 */
export const webSearchConfig = z.object({
  backends: z.array(webSearchBackend),
});
export type WebSearchConfig = z.infer<typeof webSearchConfig>;

/** 出厂默认：Exa 免费层（无 key 即可用）。 */
export const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  backends: [{ kind: "exa-mcp" }],
};
