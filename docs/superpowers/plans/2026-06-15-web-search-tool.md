# Web Search Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI a provider-agnostic `web_search` tool backed by pluggable MCP search backends (Exa first) with ordered fallback, gated per-message in a prompt-cache-stable way (tools registered by settings, per-turn enable via tail soft-hint + execute guard).

**Architecture:** A new `src/main/ai/search/` module exposes one abstract `web_search` tool whose `execute` calls a `SearchService` that walks an ordered list of `SearchBackend`s (each an MCP client over Streamable HTTP) and falls back on failure. The tool is registered for the whole session whenever settings enable web search (stable tools prefix); the per-message composer toggle flows as a soft hint appended to the current user turn plus a `turnEnabled` boolean that makes `execute` early-return when off. Config lives in a new `webSearch` preference (discriminated-union backends). Renderer adds a sticky composer toggle, a settings section, and transparent tool-step rendering.

**Tech Stack:** Electron main (TypeScript 6), Vercel AI SDK v6 (`ai`'s `tool()` / `streamText`), `@modelcontextprotocol/sdk` (Streamable HTTP client), Zod 4, Drizzle/better-sqlite3, vitest 4 (Electron runtime), React 19 + zustand + i18next.

**Reference spec:** `docs/superpowers/specs/2026-06-15-web-search-tool-design.md`.

**Conventions reminder (from CLAUDE.md / memory):**

- `pnpm test <file>` runs one file; `pnpm test -t "<name>"` filters by name. Tests run on Electron runtime — never `node -e require` for better-sqlite3.
- Logger: `import { createLogger } from "@main/logger"`; `const log = createLogger("search")`. No bare `console.*`. Error as 2nd arg: `log.warn("msg", err)`.
- IPC optional inputs use `.optional()` not `.default()`.
- New preference key ⇒ register in `PREFERENCE_SCHEMAS` **and** `setPreferenceInput` union **and** the `preferences:set` handler switch (exhaustiveness `never` guard).
- React renderer has React Compiler — don't hand-write `useCallback`/`useMemo`.
- pre-commit hook (prek) runs `lint:fix` + `format`; if it modifies files, `git add` them and re-run the same commit.
- Commit messages: Conventional Commits; end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**New (main):**

- `src/main/ai/search/types.ts` — `SearchHit`, `SearchBackend` interfaces.
- `src/main/ai/search/search-service.ts` — `SearchService` ordered-fallback engine. (+ `.test.ts`)
- `src/main/ai/search/mcp-backend.ts` — MCP-backed `SearchBackend` (`makeMcpBackend`, Exa/generic config, `mapResult` + Zod boundary). (+ `.test.ts`)
- `src/main/ai/search/web-search-tool.ts` — `makeWebSearchTool`, `createSearchTools`. (+ `.test.ts`)

**New (shared):**

- `src/shared/web-search.ts` — `webSearchBackend`, `webSearchConfig` Zod + types. (+ `.test.ts`)

**New (renderer):**

- `src/renderer/settings/WebSearchSettings.tsx` — settings section.

**Modified (main):**

- `src/shared/chat.ts` — add `webSearch` to `sendInputSchema` / `resendInputSchema`.
- `src/shared/preferences.ts` — register `webSearch` key + union arm.
- `src/main/ai/prompt.ts` — `current.webSearchEnabled` + `renderWebSearchHint`.
- `src/main/ai/send.ts` — `SendDeps.createSearchTools`, thread flag to `assemblePrompt` + ctx.
- `src/main/ai/stream-assistant.ts` — register `web_search` by settings, pass `turnEnabled`, close on finish/error.
- `src/main/ai/send-deps.ts` — wire real `createSearchTools` + read `webSearch` preference.
- `src/main/ipc/settings-handlers.ts` (or wherever `preferences:set` switches) — `webSearch` case.

**Modified (renderer):**

- `src/renderer/store/chat-store.ts` — sticky `webSearchEnabled` + setter.
- `src/renderer/ai/ipc-chat-transport.ts` — pass `webSearch` into `ai:send`.
- `src/renderer/ai/Composer.tsx` — globe toggle.
- `src/renderer/ai/tool-step-label.ts` — `web_search` case.
- `src/renderer/store/settings-store.ts` + `src/renderer/settings/SettingsShell.tsx` — `webSearch` category.
- `src/renderer/store/prefs-store.ts` + `src/renderer/store/hydrate-preferences.ts` — read `webSearch` config (toggle-disabled gate).
- locale files (i18n keys).

---

## Task 0: Install `@modelcontextprotocol/sdk`

**Files:**

- Modify: `package.json` (dependency), `pnpm-lock.yaml`

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @modelcontextprotocol/sdk`

- [ ] **Step 2: Restore Electron ABI for better-sqlite3 (postinstall normally does this; verify)**

Run: `pnpm test src/main/app-info.test.ts`
Expected: PASS (proves better-sqlite3 loads on Electron ABI 145 after install). If it fails with a NODE_MODULE_VERSION mismatch, run `pnpm db:rebuild:electron` then re-run.

- [ ] **Step 3: Sanity-check the import path**

Run: `pnpm exec node -e "1"` is NOT valid here — instead confirm the package exposes the client by checking the file exists:
Run: `ls node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`
Expected: the file path prints (confirms `@modelcontextprotocol/sdk/client/streamableHttp.js` subpath resolves). If the dist layout differs, note the actual subpath — Task 5 imports from `@modelcontextprotocol/sdk/client/index.js` and `.../client/streamableHttp.js`.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add @modelcontextprotocol/sdk for web search backend (#89)"
```

---

## Task 1: Shared web-search config contract

**Files:**

- Create: `src/shared/web-search.ts`
- Test: `src/shared/web-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/web-search.test.ts
import { describe, it, expect } from "vitest";
import { webSearchBackend, webSearchConfig } from "@shared/web-search";

describe("webSearchBackend", () => {
  it("accepts an exa-mcp backend with apiKey", () => {
    const r = webSearchBackend.safeParse({ kind: "exa-mcp", apiKey: "sk-test" });
    expect(r.success).toBe(true);
  });
  it("accepts a generic mcp backend with url + toolName", () => {
    const r = webSearchBackend.safeParse({
      kind: "mcp",
      url: "https://example.com/mcp",
      toolName: "search",
    });
    expect(r.success).toBe(true);
  });
  it("rejects a generic mcp backend with a non-URL", () => {
    const r = webSearchBackend.safeParse({ kind: "mcp", url: "not-a-url", toolName: "search" });
    expect(r.success).toBe(false);
  });
  it("rejects an unknown kind", () => {
    const r = webSearchBackend.safeParse({ kind: "brave", apiKey: "x" });
    expect(r.success).toBe(false);
  });
});

describe("webSearchConfig", () => {
  it("accepts enabled + ordered backends", () => {
    const r = webSearchConfig.safeParse({
      enabled: true,
      backends: [{ kind: "exa-mcp", apiKey: "sk" }],
    });
    expect(r.success).toBe(true);
  });
  it("accepts the empty default", () => {
    expect(webSearchConfig.safeParse({ enabled: false, backends: [] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm test src/shared/web-search.test.ts`
Expected: FAIL (`Cannot find module '@shared/web-search'`).

- [ ] **Step 3: Implement the schema**

```ts
// src/shared/web-search.ts
import { z } from "zod";

/** 单个搜索后端配置（判别联合）。exa-mcp = Exa 预设；mcp = 任意 streamable-HTTP MCP 搜索 server。 */
export const webSearchBackend = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exa-mcp"),
    label: z.string().optional(),
    apiKey: z.string(),
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

/** 联网搜索偏好：enabled 决定是否注册 web_search 工具；backends 顺序 = 回退优先级。 */
export const webSearchConfig = z.object({
  enabled: z.boolean(),
  backends: z.array(webSearchBackend),
});
export type WebSearchConfig = z.infer<typeof webSearchConfig>;

/** 出厂默认：不启用，无后端。 */
export const DEFAULT_WEB_SEARCH: WebSearchConfig = { enabled: false, backends: [] };
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm test src/shared/web-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/web-search.ts src/shared/web-search.test.ts
git commit -m "feat(shared): add webSearch config contract (#89)"
```

---

## Task 2: Register `webSearch` preference + SendInput field

**Files:**

- Modify: `src/shared/preferences.ts`
- Modify: `src/shared/chat.ts`
- Test: `src/shared/preferences.test.ts` (extend if present; else add assertions inline in web-search test is fine — but prefer the existing preferences test file)

- [ ] **Step 1: Write failing assertions**

Add to the existing `src/shared/preferences.test.ts` (create if missing) — verify the key round-trips and the union arm validates:

```ts
import { describe, it, expect } from "vitest";
import { PREFERENCE_SCHEMAS, setPreferenceInput } from "@shared/preferences";

describe("webSearch preference", () => {
  it("is registered in PREFERENCE_SCHEMAS", () => {
    expect("webSearch" in PREFERENCE_SCHEMAS).toBe(true);
  });
  it("validates a set payload", () => {
    const r = setPreferenceInput.safeParse({
      key: "webSearch",
      value: { enabled: true, backends: [{ kind: "exa-mcp", apiKey: "sk" }] },
    });
    expect(r.success).toBe(true);
  });
});
```

Also add to `src/shared/chat.ts` test coverage (create `src/shared/chat.test.ts` if none) — `webSearch` is optional:

```ts
import { describe, it, expect } from "vitest";
import { sendInputSchema } from "@shared/chat";

describe("sendInputSchema.webSearch", () => {
  it("is optional (omitted parses)", () => {
    const r = sendInputSchema.safeParse({
      bookId: "b",
      conversationId: "c",
      chips: [],
      userText: "hi",
    });
    expect(r.success).toBe(true);
  });
  it("accepts a boolean", () => {
    const r = sendInputSchema.safeParse({
      bookId: "b",
      conversationId: "c",
      chips: [],
      userText: "hi",
      webSearch: true,
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/shared/preferences.test.ts src/shared/chat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Register the preference**

In `src/shared/preferences.ts`:

- Add import at top: `import { webSearchConfig } from "@shared/web-search";`
- In `PREFERENCE_SCHEMAS`, add a line (after `avatarBlobId`): `webSearch: webSearchConfig,`
- In `setPreferenceInput` discriminated union array, add an arm: `z.object({ key: z.literal("webSearch"), value: webSearchConfig }),`

- [ ] **Step 4: Add the SendInput field**

In `src/shared/chat.ts`, in `sendInputSchema` (after `readingContext`): `webSearch: z.boolean().optional(),`
In `resendInputSchema` (after `userText`): `webSearch: z.boolean().optional(),`

- [ ] **Step 5: Run — expect pass**

Run: `pnpm test src/shared/preferences.test.ts src/shared/chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/preferences.ts src/shared/chat.ts src/shared/preferences.test.ts src/shared/chat.test.ts
git commit -m "feat(shared): register webSearch preference + SendInput.webSearch (#89)"
```

---

## Task 3: Search backend types

**Files:**

- Create: `src/main/ai/search/types.ts`

- [ ] **Step 1: Implement (no test — pure interfaces)**

```ts
// src/main/ai/search/types.ts
/** 统一搜索结果命中项（所有后端映射到此形状）。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

/** 可插拔搜索后端。search 抛错 = 该后端不可用，触发 SearchService 回退。 */
export interface SearchBackend {
  /** 仅用于日志（exa-mcp / mcp:<host> …）。 */
  readonly id: string;
  search(query: string, opts: { numResults?: number }): Promise<SearchHit[]>;
  /** 释放底层 MCP client（lazy 建则可能 no-op）。 */
  close(): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no consumers yet; just confirms it compiles).

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/search/types.ts
git commit -m "feat(search): add SearchHit/SearchBackend types (#89)"
```

---

## Task 4: SearchService ordered-fallback engine

**Files:**

- Create: `src/main/ai/search/search-service.ts`
- Test: `src/main/ai/search/search-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ai/search/search-service.test.ts
import { describe, it, expect, vi } from "vitest";
import { SearchService } from "@main/ai/search/search-service";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";

function backend(id: string, impl: () => Promise<SearchHit[]>): SearchBackend {
  return { id, search: impl, close: vi.fn().mockResolvedValue(undefined) };
}
const hit: SearchHit = { title: "t", url: "https://x", snippet: "s" };

describe("SearchService", () => {
  it("returns the first backend's results when it succeeds", async () => {
    const b1 = backend("a", vi.fn().mockResolvedValue([hit]));
    const b2 = backend("b", vi.fn().mockResolvedValue([]));
    const svc = new SearchService([b1, b2]);
    await expect(svc.search("q", {})).resolves.toEqual([hit]);
    expect(b2.search).not.toHaveBeenCalled();
  });

  it("falls back to the next backend when the first throws", async () => {
    const b1 = backend("a", vi.fn().mockRejectedValue(new Error("429")));
    const b2 = backend("b", vi.fn().mockResolvedValue([hit]));
    const svc = new SearchService([b1, b2]);
    await expect(svc.search("q", {})).resolves.toEqual([hit]);
    expect(b2.search).toHaveBeenCalled();
  });

  it("throws when all backends fail", async () => {
    const b1 = backend("a", vi.fn().mockRejectedValue(new Error("x")));
    const b2 = backend("b", vi.fn().mockRejectedValue(new Error("y")));
    const svc = new SearchService([b1, b2]);
    await expect(svc.search("q", {})).rejects.toThrow(/all web search backends failed/);
  });

  it("closes every backend", async () => {
    const b1 = backend("a", vi.fn());
    const b2 = backend("b", vi.fn());
    await new SearchService([b1, b2]).close();
    expect(b1.close).toHaveBeenCalled();
    expect(b2.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/main/ai/search/search-service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/main/ai/search/search-service.ts
import { createLogger } from "@main/logger";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";

const log = createLogger("search");

/** 有序后端 + 自动回退。任一后端抛错则试下一个；全失败则抛。 */
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

  close(): Promise<unknown> {
    return Promise.allSettled(this.backends.map((b) => b.close()));
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm test src/main/ai/search/search-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/search/search-service.ts src/main/ai/search/search-service.test.ts
git commit -m "feat(search): add SearchService ordered-fallback engine (#89)"
```

---

## Task 5: MCP-backed SearchBackend

**Files:**

- Create: `src/main/ai/search/mcp-backend.ts`
- Test: `src/main/ai/search/mcp-backend.test.ts`

This backend wraps `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`. The pure, unit-tested part is `mapExaResult` (raw MCP `content` → `SearchHit[]`); the client wiring is thin glue.

- [ ] **Step 1: Write the failing test for `mapExaResult` + config builders**

```ts
// src/main/ai/search/mcp-backend.test.ts
import { describe, it, expect } from "vitest";
import { mapExaResult, exaBackendOpts, genericBackendOpts } from "@main/ai/search/mcp-backend";

// NOTE: shape固化自首次真连 Exa MCP web_search_exa 实测（见 Step 3 注释）。
const EXA_CONTENT = [
  {
    type: "text",
    text: JSON.stringify({
      results: [
        { title: "A", url: "https://a.com", text: "snippet a", publishedDate: "2026-01-01" },
        { title: "B", url: "https://b.com", text: "snippet b" },
      ],
    }),
  },
];

describe("mapExaResult", () => {
  it("maps Exa MCP content to SearchHit[]", () => {
    expect(mapExaResult({ content: EXA_CONTENT })).toEqual([
      { title: "A", url: "https://a.com", snippet: "snippet a", publishedDate: "2026-01-01" },
      { title: "B", url: "https://b.com", snippet: "snippet b" },
    ]);
  });
  it("throws on malformed content (triggers fallback)", () => {
    expect(() => mapExaResult({ content: [{ type: "text", text: "not json" }] })).toThrow();
    expect(() => mapExaResult({ content: [] })).toThrow();
  });
});

describe("backend opts builders", () => {
  it("exaBackendOpts sets the Exa url, x-api-key header, and tool", () => {
    const o = exaBackendOpts("sk-123");
    expect(o.url).toContain("mcp.exa.ai/mcp");
    expect(o.url).toContain("tools=web_search_exa");
    expect(o.headers).toEqual({ "x-api-key": "sk-123" });
    expect(o.toolName).toBe("web_search_exa");
  });
  it("genericBackendOpts honors custom header name + tool", () => {
    const o = genericBackendOpts({
      kind: "mcp",
      url: "https://x/mcp",
      toolName: "s",
      apiKeyHeader: "authorization",
      apiKey: "k",
    });
    expect(o.headers).toEqual({ authorization: "k" });
    expect(o.toolName).toBe("s");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/main/ai/search/mcp-backend.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/main/ai/search/mcp-backend.ts
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "@main/logger";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";
import type { WebSearchBackendConfig } from "@shared/web-search";

const log = createLogger("search");

export interface McpBackendOpts {
  id: string;
  url: string;
  toolName: string;
  headers: Record<string, string>;
  mapResult: (raw: unknown) => SearchHit[];
}

const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";

/**
 * Exa MCP `web_search_exa` 返回形状——**首次真连实测后固化**。MCP tool result 为
 * { content: [{ type:"text", text:"<json>" }] }，text 内含 { results: [{ title,url,text,publishedDate? }] }。
 * 入参字段名（numResults vs num_results）亦实测确认；若 Exa 用 snake_case，在 callArgs 处调整。
 */
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

export function exaBackendOpts(apiKey: string): McpBackendOpts {
  return {
    id: "exa-mcp",
    url: EXA_MCP_URL,
    toolName: "web_search_exa",
    headers: { "x-api-key": apiKey },
    mapResult: mapExaResult,
  };
}

export function genericBackendOpts(
  cfg: Extract<WebSearchBackendConfig, { kind: "mcp" }>,
): McpBackendOpts {
  const header = cfg.apiKeyHeader ?? "x-api-key";
  return {
    id: `mcp:${new URL(cfg.url).host}`,
    url: cfg.url,
    toolName: cfg.toolName,
    headers: cfg.apiKey ? { [header]: cfg.apiKey } : {},
    mapResult: mapExaResult, // 通用后端假设 Exa 风格 payload；异形后端再特化 mapResult
  };
}

/** 把判别联合的 backend config 实例化为 McpBackendOpts。 */
export function backendOptsFor(cfg: WebSearchBackendConfig): McpBackendOpts {
  return cfg.kind === "exa-mcp" ? exaBackendOpts(cfg.apiKey) : genericBackendOpts(cfg);
}

/** MCP-backed SearchBackend：lazy 连接，复用单个 client，close 释放。 */
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
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm test src/main/ai/search/mcp-backend.test.ts`
Expected: PASS.

> ⚠️ **Real-Exa verification gate (do during smoke, Task 14):** the `mapExaResult` shape and `callTool` arg names are assumed from Exa docs. Once an Exa API key is available, run one real `web_search_exa` call (a throwaway script using `makeMcpBackend(exaBackendOpts(key)).search("test", {})`) and reconcile `exaPayloadSchema` + arg names with the actual response. Adjust `mapExaResult` and the canned `EXA_CONTENT` fixture if they differ. Log what was assumed vs observed.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/search/mcp-backend.ts src/main/ai/search/mcp-backend.test.ts
git commit -m "feat(search): add MCP-backed search backend + Exa result mapping (#89)"
```

---

## Task 6: `web_search` tool + `createSearchTools` with turn gating

**Files:**

- Create: `src/main/ai/search/web-search-tool.ts`
- Test: `src/main/ai/search/web-search-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ai/search/web-search-tool.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeWebSearchTool } from "@main/ai/search/web-search-tool";
import { SearchService } from "@main/ai/search/search-service";

function svcReturning(hits: unknown) {
  return { search: vi.fn().mockResolvedValue(hits), close: vi.fn() } as unknown as SearchService;
}

async function run(tool: ReturnType<typeof makeWebSearchTool>, input: { query: string }) {
  // AI SDK tool().execute signature: (input, options). Pass a minimal options stub.
  return (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
    toolCallId: "t1",
    messages: [],
  });
}

describe("web_search tool", () => {
  it("returns { results } when enabled and service succeeds", async () => {
    const svc = svcReturning([{ title: "A", url: "https://a", snippet: "s" }]);
    const tool = makeWebSearchTool(svc, true);
    await expect(run(tool, { query: "q" })).resolves.toEqual({
      results: [{ title: "A", url: "https://a", snippet: "s" }],
    });
  });

  it("early-returns { error } and never calls the service when turn is disabled", async () => {
    const svc = svcReturning([]);
    const tool = makeWebSearchTool(svc, false);
    const out = await run(tool, { query: "q" });
    expect(out).toHaveProperty("error");
    expect(svc.search).not.toHaveBeenCalled();
  });

  it("maps service failure to a soft { error } result", async () => {
    const svc = {
      search: vi.fn().mockRejectedValue(new Error("all failed")),
      close: vi.fn(),
    } as unknown as SearchService;
    const tool = makeWebSearchTool(svc, true);
    const out = await run(tool, { query: "q" });
    expect(out).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/main/ai/search/web-search-tool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/main/ai/search/web-search-tool.ts
import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "@main/logger";
import { SearchService } from "@main/ai/search/search-service";
import { makeMcpBackend, backendOptsFor } from "@main/ai/search/mcp-backend";
import type { WebSearchConfig } from "@shared/web-search";

const log = createLogger("search");

/** 复用 tools.ts 的软失败语义：execute 抛错转 { error } result，模型自纠、UI 标失败。 */
async function runTool<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`tool ${name} failed (error returned to model for self-correction)`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 抽象 web_search 工具。turnEnabled=false 时早返回，绝不真搜（§5 硬边界）。 */
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
            "Web search is turned off for this message. Answer from available context, " +
              "or tell the user to enable web search for this message.",
          );
        }
        const results = await service.search(query, { numResults });
        return { results };
      }),
  });
}

/** 工厂：按 config 建有序后端 + service + web_search 工具。turnEnabled 仅改 execute 行为。 */
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
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm test src/main/ai/search/web-search-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/search/web-search-tool.ts src/main/ai/search/web-search-tool.test.ts
git commit -m "feat(search): add web_search tool + createSearchTools with turn gating (#89)"
```

---

## Task 7: Tail soft-hint in prompt assembly

**Files:**

- Modify: `src/main/ai/prompt.ts`
- Test: `src/main/ai/prompt.test.ts` (extend existing; if none, create)

First read `src/main/ai/prompt.ts` to find `AssemblePromptParams` and the `renderReadingContext`/`renderUserTurn` helpers (the current-turn assembly is around lines 171–182).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/ai/prompt.test.ts  (add this describe block)
import { describe, it, expect } from "vitest";
import { renderWebSearchHint } from "@main/ai/prompt";

describe("renderWebSearchHint", () => {
  it("returns an 'available' hint when true", () => {
    expect(renderWebSearchHint(true)).toMatch(/available/i);
  });
  it("returns a 'turned off' hint when false", () => {
    expect(renderWebSearchHint(false)).toMatch(/turned off|do not/i);
  });
  it("returns null when undefined (web search not registered)", () => {
    expect(renderWebSearchHint(undefined)).toBeNull();
  });
});
```

Also assert it lands only in the current user turn (prefix stays clean). Find the existing `assemblePrompt` test (it's async); add:

```ts
import { assemblePrompt } from "@main/ai/prompt";
it("injects the web search hint only into the last user turn", async () => {
  const msgs = await assemblePrompt({
    systemPrompt: "SYS",
    priorSummary: null,
    history: [],
    current: { chips: [], userText: "hello", readingContext: null, webSearchEnabled: false },
  });
  const sys = msgs.find((m) => m.role === "system");
  expect(JSON.stringify(sys)).not.toMatch(/web search/i); // prefix clean
  const last = msgs.at(-1)!;
  expect(JSON.stringify(last)).toMatch(/turned off|do not/i);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: FAIL (`renderWebSearchHint` not exported; `webSearchEnabled` not on params type).

- [ ] **Step 3: Implement**

In `src/main/ai/prompt.ts`:

- Add to the `current` object type inside `AssemblePromptParams`: `webSearchEnabled?: boolean;`
- Add the exported helper near the other `render*` functions:

```ts
/** 当前 user turn 尾部软提示：本条联网状态。undefined（未注册工具）= 不注入。 */
export function renderWebSearchHint(enabled: boolean | undefined): string | null {
  if (enabled === undefined) return null;
  return enabled
    ? "[Web search is available for this message. Use the web_search tool when current or external information would help.]"
    : "[Web search is turned off for this message. Do not call the web_search tool; answer from available context.]";
}
```

- In the current-turn assembly array (currently `[renderReadingContext(params.current.readingContext), renderUserTurn(params.current.chips, params.current.userText)]`), append `renderWebSearchHint(params.current.webSearchEnabled)` as the last element before `.filter(...)`. The existing `.filter((s): s is string => Boolean(s))` already drops the `null`.

- [ ] **Step 4: Run — expect pass**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/prompt.ts src/main/ai/prompt.test.ts
git commit -m "feat(ai): inject tail-of-turn web search hint (cache-stable) (#89)"
```

---

## Task 8: Wire injection — SendDeps, send.ts, stream-assistant.ts, send-deps.ts

**Files:**

- Modify: `src/main/ai/send.ts` (SendDeps + thread flag)
- Modify: `src/main/ai/stream-assistant.ts` (register by settings + close)
- Modify: `src/main/ai/send-deps.ts` (real factory + read pref)
- Test: `src/main/ai/stream-assistant` is glue; cover via a focused test on the tool-merge decision if feasible, else rely on Task 12 GUI smoke. Add a small unit test for the `createSearchTools` injection decision is optional — prefer keeping glue thin.

- [ ] **Step 1: Extend `SendDeps` and thread the flag (src/main/ai/send.ts)**

- Add to `SendDeps`:

```ts
  /** 联网搜索工具工厂（注入式，便于测试 mock）；未配置则 runSend 跳过注入。 */
  createSearchTools?: (
    cfg: import("@shared/web-search").WebSearchConfig,
    turnEnabled: boolean,
  ) => { tools: Record<string, unknown>; close: () => Promise<unknown> };
  /** 当前联网搜索配置快照（settings 级）。 */
  webSearchConfig?: import("@shared/web-search").WebSearchConfig;
```

- In `runSend`, compute the turn flag and the hint, and pass into `assemblePrompt`:
  - Before `assemblePrompt({...})`, compute:

```ts
const cfg = deps.webSearchConfig;
const searchRegistered = Boolean(cfg?.enabled && cfg.backends.length);
const webSearchTurn = input.webSearch ?? false;
const webSearchEnabled = searchRegistered ? webSearchTurn : undefined;
```

- Add `webSearchEnabled` to the `current` object passed to `assemblePrompt`.
- Pass `webSearchTurn` and `cfg`/`searchRegistered` to `streamAssistantReply` via its `ctx` (extend `StreamCtx` with `webSearchTurn: boolean`).
- In `runResend`, mirror: `const webSearchTurn = input.webSearch ?? false;` set `current.webSearchEnabled` the same way and pass `webSearchTurn` into ctx.

- [ ] **Step 2: Register the tool by settings in stream-assistant.ts**

- Extend `StreamCtx` (in `stream-assistant.ts`): add `webSearchTurn: boolean;`
- In `streamAssistantReply`, after building `tools` from reading + memory, conditionally add search tools and capture a closer:

```ts
let closeSearch: (() => Promise<unknown>) | undefined;
const cfg = deps.webSearchConfig;
if (deps.createSearchTools && cfg?.enabled && cfg.backends.length) {
  const s = deps.createSearchTools(cfg, ctx.webSearchTurn);
  Object.assign(tools, s.tools);
  closeSearch = s.close;
}
```

- In the `toUIMessageStream` `onFinish` callback (and `onError`), call `void closeSearch?.();`. Also call it in the drain `finally` (around the `resolveDone()` block) to cover abort:

```ts
    } finally {
      void closeSearch?.();
      resolveDone();
    }
```

(Placing it in the drain `finally` guarantees one close per reply regardless of finish/error/abort; the `onFinish`/`onError` calls are belt-and-suspenders — make it idempotent by relying on `makeMcpBackend.close()` already guarding `if (client)`.)

- [ ] **Step 3: Provide the real factory + read the preference (send-deps.ts)**

In `src/main/ai/send-deps.ts`, inside `makeSendDeps()`:

- Import: `import { createSearchTools } from "@main/ai/search/web-search-tool";` and `import { DEFAULT_WEB_SEARCH } from "@shared/web-search";`
- Add to the returned object:

```ts
    createSearchTools,
    webSearchConfig: getPreference(db, "webSearch") ?? DEFAULT_WEB_SEARCH,
```

- [ ] **Step 4: Typecheck + run existing AI tests**

Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm test src/main/ai`
Expected: PASS (existing send/stream/prompt tests unaffected; search tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/send.ts src/main/ai/stream-assistant.ts src/main/ai/send-deps.ts
git commit -m "feat(ai): register web_search by settings + thread per-turn gate (#89)"
```

---

## Task 9: `preferences:set` handler case

**Files:**

- Modify: the handler that switches on preference key for `preferences:set` (grep for `"chatModel"` case or `setPreferenceInput` usage — likely `src/main/ipc/settings-handlers.ts` or `src/main/preferences/repository.ts`).

- [ ] **Step 1: Locate the switch**

Run: `grep -rn "case \"chatModel\"" src/main`
This points at the `preferences:set` exhaustiveness switch (memory: missing case = silent no-op; `never` guard present).

- [ ] **Step 2: Add the `webSearch` case**

Mirror the `chatModel` arm. Typically:

```ts
    case "webSearch":
      setPreference(db, "webSearch", input.value);
      return;
```

(Use the exact persistence call the neighboring cases use — read the file to match the real signature.)

- [ ] **Step 3: Verify it persists (sqlite is source of truth — memory)**

Add/extend a repository test if the file has one (e.g. `src/main/preferences/repository.test.ts`): set `webSearch`, read it back, assert deep-equal. Run: `pnpm test src/main/preferences`
Expected: PASS. If no test file exists, at minimum `pnpm typecheck` must pass (the `never` guard compiles only when the case exists).

- [ ] **Step 4: Commit**

```bash
git add -A src/main
git commit -m "feat(ipc): handle webSearch in preferences:set (#89)"
```

---

## Task 10: Renderer — sticky toggle + transport passthrough

**Files:**

- Modify: `src/renderer/store/chat-store.ts`
- Modify: `src/renderer/ai/ipc-chat-transport.ts`
- Modify: `src/renderer/ai/Composer.tsx`

Read each file first — the snippets below match the structure reported during planning but confirm exact field names.

- [ ] **Step 1: Add sticky `webSearchEnabled` to chat-store**

In `src/renderer/store/chat-store.ts`:

- Add `webSearchEnabled: boolean;` to the state interface and `setWebSearchEnabled: (v: boolean) => void;` to actions.
- Add `webSearchEnabled: false` to the initial state.
- Add `setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),` to the store creator.
- Do NOT add it to `partialize` (it's session-sticky, not persisted — matches existing draft fields).

- [ ] **Step 2: Pass it through the transport**

In `src/renderer/ai/ipc-chat-transport.ts`, where `window.api.ai.send({...})` is called, add the field:

```ts
const webSearch = useChatStore.getState().webSearchEnabled;
const ack = await window.api.ai.send({
  streamId,
  bookId: currentBookId,
  conversationId,
  chips,
  userText,
  readingContext,
  webSearch,
});
```

(If `resend`/regenerate has its own `window.api.ai.resend` call in the same file, add `webSearch` there too.)

- [ ] **Step 3: Add the globe toggle to Composer**

In `src/renderer/ai/Composer.tsx`:

- Import `Globe` from `lucide-react` and the store selectors:

```ts
const webSearchEnabled = useChatStore((s) => s.webSearchEnabled);
const setWebSearchEnabled = useChatStore((s) => s.setWebSearchEnabled);
```

- Read whether web search is configured (gate from prefs-store — added in Task 12; until then default to `true` so the toggle is usable, and tighten in Task 12):

```ts
const webSearchConfigured = usePrefsStore((s) => s.webSearch?.enabled ?? false);
```

- Render a toggle button in the composer button row (next to send), e.g.:

```tsx
<Button
  type="button"
  variant={webSearchEnabled ? "default" : "ghost"}
  size="icon-lg"
  disabled={!webSearchConfigured}
  aria-label={t("ai.webSearch.toggle", "联网搜索")}
  title={
    webSearchConfigured ? undefined : t("ai.webSearch.notConfigured", "请先在设置中配置联网搜索")
  }
  onClick={() => setWebSearchEnabled(!webSearchEnabled)}
>
  <Globe />
</Button>
```

(Place it before the send/stop button. Match existing Button sizing/idioms in the file.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (note: `usePrefsStore((s) => s.webSearch)` requires the prefs-store field from Task 12 — if doing Task 10 before 12, temporarily hardcode `const webSearchConfigured = true;` and revisit in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/chat-store.ts src/renderer/ai/ipc-chat-transport.ts src/renderer/ai/Composer.tsx
git commit -m "feat(renderer): sticky web search toggle in composer + transport passthrough (#89)"
```

---

## Task 11: Renderer — tool-step label + i18n

**Files:**

- Modify: `src/renderer/ai/tool-step-label.ts`
- Test: `src/renderer/ai/tool-step-label.test.ts` (extend)
- Modify: locale files (`src/shared/i18n/locales/...`)

- [ ] **Step 1: Write the failing test**

In `src/renderer/ai/tool-step-label.test.ts`, add (use the existing test's helper for building a tool part; mirror the `readPage` case test):

```ts
it("labels web_search with the query", () => {
  const part = {
    type: "tool-web_search",
    input: { query: "weather" },
    state: "input-available",
  } as any;
  expect(toolStepLabel(part, [], tStub)).toMatch(/weather/);
});
it("falls back when query missing", () => {
  const part = { type: "tool-web_search", input: {}, state: "input-streaming" } as any;
  expect(toolStepLabel(part, [], tStub)).toBeTruthy();
});
```

(Use the same `tStub` / `t` the existing tests use — likely an identity-ish `t` returning the fallback.)

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/renderer/ai/tool-step-label.test.ts`
Expected: FAIL (default branch returns the raw tool name `web_search`, not the labeled string).

- [ ] **Step 3: Implement the case**

In `toolStepLabel`'s `switch (name)`, add before `default`:

```ts
    case "web_search": {
      const query = input?.query;
      return typeof query === "string"
        ? t("ai.toolStep.webSearch", "联网搜索：{{query}}", { query })
        : t("ai.toolStep.webSearchFallback", "联网搜索");
    }
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm test src/renderer/ai/tool-step-label.test.ts`
Expected: PASS.

- [ ] **Step 5: Extract i18n keys + add composer/settings strings**

Run: `pnpm i18n:extract`
Then ensure these keys have sensible primary-language values (add by hand if extract didn't capture the runtime ones): `ai.toolStep.webSearch`, `ai.toolStep.webSearchFallback`, `ai.webSearch.toggle`, `ai.webSearch.notConfigured`, plus settings keys used in Task 12 (`settings.webSearch`, `settings.webSearch.enable`, `settings.webSearch.apiKey`, etc.).
Run: `pnpm i18n:lint` (and grep to confirm — `i18n:lint` under-reports per memory).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ai/tool-step-label.ts src/renderer/ai/tool-step-label.test.ts src/shared/i18n/locales
git commit -m "feat(renderer): render web_search tool step + i18n keys (#89)"
```

---

## Task 12: Renderer — prefs hydration + settings section

**Files:**

- Modify: `src/renderer/store/prefs-store.ts` (add `webSearch` config field)
- Modify: `src/renderer/store/hydrate-preferences.ts` (hydrate it)
- Modify: `src/renderer/store/settings-store.ts` (add `webSearch` category)
- Modify: `src/renderer/settings/SettingsShell.tsx` (nav + render)
- Create: `src/renderer/settings/WebSearchSettings.tsx`

Read each store/settings file first to match exact shapes.

- [ ] **Step 1: prefs-store — hold the config**

Add to prefs-store state: `webSearch: WebSearchConfig | null;` (init `null`), and a setter `setWebSearch`. Import `WebSearchConfig` from `@shared/web-search`.

- [ ] **Step 2: hydrate-preferences — load snapshot**

In `hydratePreferences()`, add: `if (snap.webSearch) usePrefsStore.setState({ webSearch: snap.webSearch });`

- [ ] **Step 3: Tighten the Composer gate (from Task 10)**

Replace the temporary `const webSearchConfigured = true;` (if used) with `usePrefsStore((s) => s.webSearch?.enabled ?? false)`.

- [ ] **Step 4: settings-store — add the category**

Add `"webSearch"` to the `SettingsCategory` union.

- [ ] **Step 5: SettingsShell — nav entry + render**

Add to the `CATEGORIES` array: `{ key: "webSearch", label: t("settings.webSearch", "联网搜索") },` and render `{active === "webSearch" && <WebSearchSettings />}`.

- [ ] **Step 6: WebSearchSettings.tsx — the form**

```tsx
// src/renderer/settings/WebSearchSettings.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import type { WebSearchConfig } from "@shared/web-search";

export function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearch = usePrefsStore((s) => s.webSearch);
  const setWebSearch = usePrefsStore((s) => s.setWebSearch);
  const cfg: WebSearchConfig = webSearch ?? { enabled: false, backends: [] };

  const exa = cfg.backends.find((b) => b.kind === "exa-mcp");
  const [apiKey, setApiKey] = useState(exa && "apiKey" in exa ? exa.apiKey : "");

  const persist = (next: WebSearchConfig) => {
    setWebSearch(next);
    void window.api.preferences.set({ key: "webSearch", value: next });
  };

  const onToggle = (enabled: boolean) => persist({ ...cfg, enabled });

  const onSaveKey = () =>
    persist({
      ...cfg,
      backends: apiKey ? [{ kind: "exa-mcp", apiKey }] : [],
    });

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.webSearch", "联网搜索")}</h2>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="ws-enable" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.webSearch.enable", "启用联网搜索")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.webSearch.enableHint",
              "允许 AI 在你逐条勾选「联网」时检索外部信息（Exa）。",
            )}
          </span>
        </label>
        <Checkbox
          id="ws-enable"
          checked={cfg.enabled}
          onCheckedChange={(v) => onToggle(Boolean(v))}
          className="mt-0.5"
        />
      </div>
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground">
          {t("settings.webSearch.apiKey", "Exa API Key")}
        </span>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="exa-…"
          />
          <Button type="button" variant="outline" size="sm" onClick={onSaveKey}>
            {t("common.save", "保存")}
          </Button>
        </div>
      </div>
    </section>
  );
}
```

(Match the actual `window.api.preferences.set` signature and the Input/Checkbox/Button component APIs from neighboring settings files — read `ReadingSettings.tsx`/`ProviderForm.tsx` to confirm.)

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts src/renderer/store/settings-store.ts src/renderer/settings/SettingsShell.tsx src/renderer/settings/WebSearchSettings.tsx src/renderer/ai/Composer.tsx
git commit -m "feat(renderer): web search settings section + prefs hydration (#89)"
```

---

## Task 13: Full check — typecheck, lint, tests

**Files:** none (verification)

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Lint + format**

Run: `pnpm lint && pnpm format:check`
Expected: PASS (or `pnpm lint:fix && pnpm format` then re-check).

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS (all new + existing).

- [ ] **Step 4: i18n status**

Run: `pnpm i18n:lint`
Expected: no missing keys for the primary language (grep-verify per memory).

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "chore: typecheck/lint/i18n fixups for web search (#89)" || echo "nothing to commit"
```

---

## Task 14: Manual GUI smoke + real Exa verification

**Files:** none (manual verification — see `verify` skill / Playwright CDP memory)

- [ ] **Step 1: Launch dev app against an isolated profile**

Run `pnpm start` (blocks) with a throwaway `--user-data-dir` per the dev CDP smoke memory; or use the `run`/`verify` skill. Confirm the app boots.

- [ ] **Step 2: Configure + verify the happy path (needs an Exa API key)**

- Open Settings → 联网搜索 → enable + paste Exa key → save.
- In a book's AI panel, toggle 联网 on, ask a question that needs current info. Confirm a 「联网搜索：…」 step row appears and the answer uses fetched info.
- **Reconcile the Exa shape (Task 5 gate):** if results are empty or malformed, inspect the raw `callTool` response (add a temporary `log.debug` in `makeMcpBackend.search`), fix `mapExaResult`/arg names + the canned fixture, re-run `pnpm test src/main/ai/search/mcp-backend.test.ts`, and commit the correction.

- [ ] **Step 3: Verify the gate + cache-stability intent**

- Toggle 联网 off, ask again: the model should answer without a search step (soft hint). If it still calls, the step row shows failure (execute guard) and no real search happens — acceptable.
- Confirm reading/memory tools still work with web search both on and off (no `tool_choice` collateral).

- [ ] **Step 4: Commit any reconciliation**

```bash
git add -A
git commit -m "fix(search): reconcile Exa MCP result shape from real call (#89)" || echo "nothing to reconcile"
```

---

## Done criteria

- All tasks committed on `feat/ai-web-search-tool`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.
- GUI smoke: web search works when enabled+toggled; off-toggle answers without searching; reading/memory tools unaffected; tool step row renders.
- Then: `pnpm changeset` (user-facing English entry), finish the branch (PR), close #89, move kanban card.
