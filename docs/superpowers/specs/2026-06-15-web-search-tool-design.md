# 网络搜索工具设计（#89）

- 日期：2026-06-15
- Issue：[#89 Add web search tool for AI](https://github.com/EurFelux/marginalia/issues/89)
- 范围：主进程 AI 工具层（`src/main/ai/`）+ shared 契约 + 渲染层 composer/settings 小改 + 一个新 preference
- 状态：待用户确认

## 1. 背景与问题

选区问 AI 时，模型只能依赖书内文本 + 自身训练知识（截止日期前）。遇到时效性 / 书外信息（当下事件、作者背景、书中未覆盖的术语）答不准甚至幻觉。现有 AI 工具集（`src/main/ai/tools.ts` 的 `getToc`/`readChapterText`/`readPage`/`getChapterSummary` + `memory-tools.ts`）全是「读书内 / 记忆」工具，没有任何联网能力。

设计探索结论（2026-06-15 与用户多轮确认）：

- **不接 provider 原生 web search**（Anthropic `web_search_20250305` / OpenAI `web_search` / Google grounding）——三家形态各异、要逐家适配 `providerOptions`，且其结果持久化/UI 与现有 client-executed 工具完全不同形态。**统一走一条 client 端工具路径**，对 4 家 provider + DeepSeek 等 OpenAI 兼容网关一视同仁。
- 搜索能力以 **MCP 搜索 server** 为后端，首发 **Exa**（`https://mcp.exa.ai/mcp`）。
- **暴露给模型的是抽象工具 `web_search`**，不是 Exa 特有的 `web_search_exa`——后端在背后切换/回退时，模型看到的工具名与契约始终不变、完全无感知。
- **每条消息显式开关**触发（composer toggle），不做全局 always-on，符合「bounded、别每条都搜」。
- **多后端有序回退**：一个后端额度耗尽/失败，自动切下一个（用户明确诉求：「Exa 额度用完要能用别的」）。

## 2. 目标与非目标

**目标**

1. 模型可调用单一抽象工具 `web_search(query)`，按需检索外部信息；工具调用/结果走现有 `UIMessage` parts 持久化与内联步骤行 UI（复用 #31）。
2. 后端可插拔：`SearchBackend` 接口 + `SearchService` 有序回退引擎；首发 `ExaMcpBackend`（Exa MCP）+ 通用 `GenericMcpBackend`（任意 streamable-HTTP MCP 搜索 server）。
3. 每条消息显式开关：composer「联网」toggle → `SendInput.webSearch`；仅本条勾选且后端已启用配置时，才把 `web_search` 工具交给模型。
4. 配置驱动：一个 `webSearch` preference 存 `{ enabled, backends: BackendConfig[] }`（有序=优先级，判别联合）。
5. 依赖注入保持无头可测：搜索工具工厂经 `SendDeps` 注入，测试注 mock，不连真 MCP。

**非目标（YAGNI / 记 backlog）**

- **provider 原生 web search**——列为未来增强（统一路径已覆盖全 provider）。
- **专门 citation 来源卡片 UI**——MVP 靠模型在回复正文带 markdown 来源链接 + 步骤行可见搜索动作；来源卡片作未来增强。
- **完整的多后端管理 UI（拖拽排序 / 任意增删）**——回退引擎首版做全，但 Settings UI 分阶段（见 §10）：首版 Exa 预设 + 一个自定义 MCP 备用即可体现回退；完整列表管理迭代补。
- **Exa 其他工具**（`crawling_exa` / `deep_search_exa` / `company_research_exa` 等）——只用 `web_search_exa`。
- **由模型/系统自动判断"何时该搜"**——交给模型在工具可用时自主决定，不加启发式。
- **非 MCP 的 REST 后端**（直连 Brave/Serper REST）——接口已为其留位，但首版不实现。

## 3. 架构总览与数据流

```
composer「联网」toggle（默认关）
   └─ 勾选 → SendInput.webSearch = true
        │
runSend / stream-assistant（主进程）
   ├─ 读 webSearch preference（{ enabled, backends }）
   ├─ if (webSearch flag && enabled && backends 非空):
   │     createSearchTools(config) → { tools: { web_search }, close }
   │     tools 与 reading/memory 工具同级合并进 streamText
   ├─ streamText 跑：模型按需调 web_search
   │     web_search.execute(query)
   │        └─ SearchService.search(query)   // 有序遍历 backends，失败回退
   │             └─ ExaMcpBackend.search → MCP callTool("web_search_exa") → SearchHit[]
   └─ onFinish / onError / abort → close()   // 关所有已建 MCP client
```

- 工具调用与结果作为 `web_search` 的 tool part 流式 + 落 `messages.parts`（**零持久化改动**）。
- 未勾选 / 未启用 / 无后端 → 不注入，行为与现状完全一致。

## 4. 抽象搜索工具与后端（核心，主进程 `src/main/ai/search/`）

### 4.1 抽象工具 `web_search`

模型看到的唯一工具，契约稳定、后端无关：

```ts
web_search: tool({
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
      const results = await service.search(query, { numResults });
      return { results }; // SearchHit[]
    }),
});
```

- 复用 `tools.ts` 现有 `runTool` wrapper：内部异常转 `{ error: string }` 正常 result（软失败语义，模型自纠、UI 标失败行，与现有工具一致）。
- 结果形态统一：`SearchHit { title: string; url: string; snippet: string; publishedDate?: string }`。
- 工具名固定 `web_search`，**绝不暴露 Exa / 后端名**给模型、持久化或 UI。

### 4.2 `SearchBackend` 接口与 `SearchService`（回退引擎）

```ts
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchBackend {
  readonly id: string; // 仅用于日志（exa-mcp / mcp:<host> …）
  search(query: string, opts: { numResults?: number }): Promise<SearchHit[]>;
  close(): Promise<void>; // 释放底层 MCP client（lazy 建则可能 no-op）
}

/** 有序后端 + 自动回退。 */
export class SearchService {
  constructor(private backends: SearchBackend[]) {}

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

  close() {
    return Promise.allSettled(this.backends.map((b) => b.close()));
  }
}
```

- **回退判定**：任何 backend 抛错（额度 401/402/429、网络、5xx、解析失败）都视为该后端不可用 → 试下一个；全失败 → `service.search` 抛错 → `runTool` 转软失败 `{ error }` 回模型。区分额度 vs 其他仅影响日志措辞，不影响回退动作（一律回退）。
- **已知点（未来优化）**：同一会话内模型多次调 `web_search` 时，每次都从 `backends[0]` 重新尝试——若首选已额度耗尽会每次先撞一次 429 再回退。首版不做「会话内 backend 健康记忆/熔断」，可接受；列为后续优化。
- `log` = `createLogger("search")`（新增短域名；按既有「优雅吞错处必留 warn」记，每次回退留 warn）。

### 4.3 `ExaMcpBackend` / `GenericMcpBackend`

两者共享一个「MCP 搜索 backend」实现，仅配置不同：

```ts
interface McpBackendOpts {
  id: string;
  url: string; // exa: https://mcp.exa.ai/mcp?tools=web_search_exa
  toolName: string; // exa: web_search_exa
  headers: Record<string, string>; // exa: { "x-api-key": apiKey }
  mapResult: (raw: unknown) => SearchHit[];
}
```

- 内部用官方 **`@modelcontextprotocol/sdk`** 的 `Client` + `StreamableHTTPClientTransport`，`callTool({ name: toolName, arguments: { query, numResults } })`，从 `result.content` 解析。**入参字段名**（`numResults` vs `num_results` 等）与返回形状均**实现时对 Exa MCP 实测一次**再固化。
  - **为何不用 `@ai-sdk/mcp` 透传**：那是把 MCP tools 直接给模型；我们要的是抽象工具内部**自己调用** MCP 拿 raw 结果再映射，官方 client + `callTool` 更直接。（备选 `@ai-sdk/mcp` 的 `createMCPClient().tools()` 亦可调其 `.execute`，但需构造 AI SDK 的 tool options，更绕。）
- **client lazy 建**：首次 `search` 才建 transport+connect 并缓存；没轮到的 backend 不连。`close()` 关已建的。
- `mapResult`：Exa MCP `web_search_exa` 的返回内容形状**实现时实测一次**（MCP `content: [{ type:"text", text }]`，text 内多为 JSON），用 Zod 在此边界校验后映射成 `SearchHit[]`（外部 API 形状，schema 放本模块、不入 `@shared`，仿 `provider-models.ts` 的边界校验做法）。

### 4.4 工厂与注入边界 `createSearchTools`

```ts
export function createSearchTools(cfg: WebSearchConfig): {
  tools: ToolSet; // { web_search }
  close: () => Promise<unknown>;
} {
  const backends = cfg.backends.filter((b) => b.enabled !== false).map(makeBackend); // 判别联合 → ExaMcpBackend / GenericMcpBackend
  const service = new SearchService(backends);
  return { tools: { web_search: makeWebSearchTool(service) }, close: () => service.close() };
}
```

- 仿现有 `createReadingTools` / `createMemoryTools` 的纯工厂模式。
- 经 `SendDeps` 注入（见 §6），生产用真实 MCP，**测试注 mock backend**（不连网络）。

## 5. MCP client 生命周期

- 生命周期 = 单次助手回复。`stream-assistant.ts` 在合并工具时若启用了搜索则建 `{ tools, close }`；现有 `onFinish` 回调已落库，**追加 `await close()`**；并在 `onError` 与 abort 路径同样 close（防连接泄漏）。
- 流式期间模型可多次调 `web_search`，复用同一 service / 已建 client（lazy 缓存）。

## 6. IPC、触发与注入

### 6.1 SendInput 加字段（`src/shared/chat.ts`）

- `sendRequest` 与 `resendRequest` 各加 `webSearch: z.boolean().optional()`。
  - **用 `.optional()` 不用 `.default()`**（遵 `ipc-input-default-vs-optional` 记忆：`InferIn` 取 output，`.default()` 会让字段对调用方变必填）；handler 侧兜底 `?? false`。
- 编辑重发（#edit-resend）同样透传本条 `webSearch`（从 composer 当前 toggle 取）。

### 6.2 注入（`SendDeps` / `app-handlers`）

- `SendDeps` 加 `createSearchTools?: (cfg: WebSearchConfig) => { tools; close }`（默认值=真实工厂；测试注 mock）。
- `stream-assistant`：`if (input.webSearch && cfg.enabled && cfg.backends.length) { const s = deps.createSearchTools(cfg); merge s.tools; register s.close }`。
- `cfg` 由 handler 从 DB 读 `webSearch` preference 注入。

### 6.3 composer toggle（`src/renderer/ai/Composer.tsx`）

- 加「联网」toggle 按钮（Tailwind 按下态，lucide 图标）。toggle 是**粘滞 UI 状态**（开了保持，用户随时可关），每次发送读当前值写入 `SendInput.webSearch`——既"显式可控"又不必每条重开。
- **无 key / 未启用时**：toggle disabled + tooltip 引导去设置（不弹 OS 弹窗——用既有 toast/tooltip，遵 `no-os-dialogs` 记忆）。

## 7. 配置与存储

### 7.1 preference `webSearch`（判别联合，`src/shared/`）

```ts
export const webSearchBackend = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exa-mcp"),
    label: z.string().optional(),
    apiKey: z.string(), // 明文落库（safeStorage 已退役，PR #16）
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp"), // 任意 streamable-HTTP MCP 搜索 server
    label: z.string().optional(),
    url: z.string().url(),
    toolName: z.string().min(1),
    apiKeyHeader: z.string().optional(), // 默认 "x-api-key"
    apiKey: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
]);

export const webSearchConfig = z.object({
  enabled: z.boolean(),
  backends: z.array(webSearchBackend), // 顺序 = 回退优先级
});
```

- 存储用 **preferences 表的新 key `webSearch`**（值即上面的 object）。
  - **注意 `preferences:set` 穷尽性**（`preferences-set-switch-exhaustiveness` 记忆）：注册新 key 必须在 set 的 switch 加 case，否则 IPC 成功但静默不落盘；`never` 守卫已在，会编译期提醒。
- secret 与配置同存一个 JSON 值（明文，与现有 provider key 明文落库一致）。

### 7.2 默认/空态

- 默认 `{ enabled: false, backends: [] }`——开箱不启用，不影响现有用户。
- 用户在 settings 启用 + 填 Exa key 后，`backends = [{ kind:"exa-mcp", apiKey }]`，`enabled=true`。

## 8. 持久化与 UI

- **持久化零改动**：`web_search` 的 tool call/result 是普通 tool part，走现有 `appendMessage` → `messages.parts`。
  - prompt 组装侧历史 tool parts 仍被过滤不回放（现状 + `history-replay-tool-parts`）——搜索结果天然不需跨轮回放，每轮按需重搜，契合。
- **步骤行**（`src/renderer/ai/tool-step-label.ts`，复用 #31）：加 `web_search` case →「联网搜索：<query>」+ 状态（搜索中…/完成/失败），lucide 图标（如 `globe`/`search`）；失败判定复用 `isErrorShape`（软失败 `{ error }`）。**只显示抽象工具**，不暴露后端。
- i18n：新增 `ai.toolStep.webSearch`（「联网搜索：{{query}}」）+ fallback、composer toggle 文案、settings 区文案。注意 i18n 工作流坑（`i18n-operational-gotchas`：extract 先于 typecheck、改键结构警惕反向覆盖）。

## 9. 错误处理

| 情形                             | 行为                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| 某 backend 额度耗尽 / 网络 / 5xx | `SearchService` 捕获 + `log.warn` + 回退下一个                                   |
| 全部 backend 失败                | `service.search` 抛错 → `runTool` 转软失败 `{ error }` → 步骤行标失败 + 模型自纠 |
| 未启用 / 无 key / 无 backend     | 不注入工具，对话照常（与现状一致），composer toggle disabled 引导                |
| MCP 结果形状异常                 | `mapResult` 的 Zod 边界校验失败即抛 → 当作该 backend 失败 → 回退                 |
| 连接泄漏风险                     | onFinish/onError/abort 一律 `close()` 所有已建 client                            |

- 错误信息**不编造**（`honest-error-no-fabrication`）：日志透传真实异常；给模型的软失败 message 用通用「web search unavailable」即可（模型只需知道失败、自纠）。

## 10. Settings UI（分阶段，`src/renderer/settings/`）

并入现有双栏设置面（RA5 的 `SettingsShell`）。**首版（本 spec）**：

- 新增一个「联网搜索」设置区（可作 `ModelsSettings` 下的子块或新分类，实现时按 UI 密度定）：
  - 「启用联网搜索」开关 → `webSearch.enabled`。
  - Exa API key 输入（masked + reveal，仿 `ProviderForm` 的 key 处理）→ `backends[0] = { kind:"exa-mcp", apiKey }`。
  - （可选高级）「添加备用 MCP server」：url + toolName + key header/key → 追加一个 `kind:"mcp"` backend，体现回退。
- IPC 复用现有 `preferences:get/set`（新增 `webSearch` key 的 case）。

**迭代（非本 spec）**：完整多后端列表管理（任意增删、拖拽排序、各自启用）。

## 11. 测试策略

无头优先、纯函数 + 注入 mock（不连真 MCP）：

1. `search-service.test.ts`：有序回退——首个成功直返；首个抛错→用第二个；全抛→`search` 抛错（且每次回退留 warn）；`close` 调用全 backend。
2. `web-search-tool.test.ts`：注 mock `SearchService`——成功返 `{ results }`；service 抛错经 `runTool` 转 `{ error }`（软失败形状，`isErrorShape` 可识别）。
3. `mcp-backend.test.ts`：`mapResult` 喂 Exa MCP 真实返回 canned JSON（实测后固化）→ `SearchHit[]`；Zod 边界——非法/缺字段→抛（触发回退）；`numResults` 透传。
4. `src/shared/*.test.ts`：`webSearchConfig` / `webSearchBackend` 判别联合校验；`sendRequest.webSearch` optional（省略=undefined，handler 兜底 false）。
5. `stream-assistant` 注入点：`webSearch=true`+enabled+backend→`web_search` 在 tools；false/未启用→不在；流末 `close` 被调。
6. 渲染层 composer toggle / settings：人工 GUI smoke（toggle 状态进 send、无 key disabled+引导、启用填 key 后真流式搜索出步骤行）。可选真连 Exa 冒烟（需 key，手动）。

## 12. 依赖

- 新增 `@modelcontextprotocol/sdk`（官方 MCP client，`StreamableHTTPClientTransport` + `callTool`）。
  - 装包注意 better-sqlite3 ABI：`pnpm install` 会按系统 Node 重编 137，根 `postinstall` 自动翻回 Electron 145（CLAUDE.md 坑），装后以 `pnpm test` 验，不靠 `node -e require`。
- 不新增 `@ai-sdk/mcp`（本设计不透传 MCP tools）。

## 13. 涉及文件清单

**新增**

- `src/main/ai/search/types.ts`（`SearchHit` / `SearchBackend`）
- `src/main/ai/search/search-service.ts`（回退引擎，+ test）
- `src/main/ai/search/mcp-backend.ts`（Exa/通用 MCP backend + `mapResult` + Zod 边界，+ test）
- `src/main/ai/search/web-search-tool.ts`（`web_search` tool + `createSearchTools`，+ test）
- `src/renderer/settings/WebSearchSettings.tsx`（或并入 ModelsSettings 子块）

**修改**

- `src/shared/chat.ts`（`sendRequest`/`resendRequest` 加 `webSearch` optional）
- `src/shared/`（`webSearchConfig` / `webSearchBackend` 契约 + preference key 注册，+ test）
- `src/main/ai/stream-assistant.ts`（合并 search 工具 + onFinish/onError/abort close）
- `src/main/ai/send.ts` / `send-deps`（`createSearchTools` 注入、读 webSearch flag/config）
- `src/main/ipc/*-handlers.ts` + `preferences:set` switch（新增 `webSearch` case，穷尽性守卫）
- `src/renderer/ai/Composer.tsx`（联网 toggle）
- `src/renderer/ai/tool-step-label.ts`（`web_search` 标签 + 图标 + 软失败）
- locale 文件（新 key）
- `src/main/logger`（新增 `search` 短域名，若需）

**关联 issue**：closes #89。

## 14. 范围说明

中等。后端是主体（抽象工具 + 回退引擎 + MCP backend，约 4 个小文件 + 测试），契合现有工具/注入/持久化框架，增量小且内聚。渲染层仅 composer toggle + settings 一块。模型侧提示词、消息存储、流式 IPC 主干零改动。多后端回退引擎首版做全；Settings 完整管理 UI 分阶段。
