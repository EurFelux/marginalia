import { z } from "zod";

/**
 * 单个搜索后端配置（判别联合）。exa-mcp = Exa 预设；deepseek = DeepSeek Search/Fetch API 预设
 * （key 复用内置 DeepSeek provider，不入此配置）；mcp = 任意 streamable-HTTP MCP 搜索 server。
 */
export const webSearchBackend = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exa-mcp"),
    label: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("deepseek"),
    label: z.string().optional(),
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

/** 联网搜索偏好：backends 顺序 = 回退优先级（工具注册由启用的后端决定，per-message 开关走 webSearchEnabled 偏好）。 */
export const webSearchConfig = z.object({
  backends: z.array(webSearchBackend),
});
export type WebSearchConfig = z.infer<typeof webSearchConfig>;

/** 出厂默认：Exa 免费层（无 key 即可用）。DeepSeek 按次计费，须用户主动启用。 */
export const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  backends: [{ kind: "exa-mcp" }],
};

/** 模型可见的联网工具名。 */
export type WebToolName = "web_search" | "web_fetch";

/** 启用的后端（`enabled` 省略视为启用），顺序不变。 */
export function enabledBackends(cfg: WebSearchConfig): WebSearchBackendConfig[] {
  return cfg.backends.filter((b) => b.enabled !== false);
}

/** 后端是否支持读取网页（web_fetch）。 */
export function backendSupportsFetch(b: WebSearchBackendConfig): boolean {
  return b.kind === "deepseek";
}

/**
 * 本会话会注册哪些联网工具：有启用的后端即注册 web_search，其中有支持读取的再注册 web_fetch。
 * 只看配置、不看 key 是否存在——工具注册、尾部提示、联网 pill 共用这一判定，避免分叉。
 */
export function webToolNames(cfg: WebSearchConfig): WebToolName[] {
  const enabled = enabledBackends(cfg);
  if (enabled.length === 0) return [];
  return enabled.some(backendSupportsFetch) ? ["web_search", "web_fetch"] : ["web_search"];
}

export type PresetBackendConfig = Extract<WebSearchBackendConfig, { kind: "exa-mcp" | "deepseek" }>;

const PRESET_DEFAULTS: PresetBackendConfig[] = [
  { kind: "exa-mcp", enabled: false },
  { kind: "deepseek", enabled: false },
];

function isPreset(b: WebSearchBackendConfig): b is PresetBackendConfig {
  return b.kind !== "mcp";
}

/**
 * 设置页展示用的预设列表：Exa、DeepSeek 各一项，按配置里的顺序；配置里缺的追加到末尾并设为关闭。
 * `mcp` 条目不展示（应用里没有创建入口，spec 2026-10-17-deepseek-web-backend-design §7.1）。
 */
export function presetBackendList(cfg: WebSearchConfig): PresetBackendConfig[] {
  const present = cfg.backends.filter(isPreset);
  // 同 kind 重复时只保留第一个（UI 造不出重复，防御手改的配置）
  const ordered = present.filter((b, i) => present.findIndex((p) => p.kind === b.kind) === i);
  const missing = PRESET_DEFAULTS.filter((p) => !ordered.some((b) => b.kind === p.kind));
  return [...ordered, ...missing];
}

/** 设置页写回：改动后的预设列表 + 原配置里的 `mcp` 条目（原样追加在末尾，不丢手改的配置）。 */
export function applyPresetBackendList(
  cfg: WebSearchConfig,
  list: PresetBackendConfig[],
): WebSearchConfig {
  return { backends: [...list, ...cfg.backends.filter((b) => !isPreset(b))] };
}

/** 后端的显示名：品牌名不翻译；`mcp` 条目用 label 或 host。 */
export function backendDisplayName(b: WebSearchBackendConfig): string {
  switch (b.kind) {
    case "exa-mcp":
      return "Exa";
    case "deepseek":
      return "DeepSeek";
    case "mcp":
      return b.label ?? new URL(b.url).host;
  }
}
