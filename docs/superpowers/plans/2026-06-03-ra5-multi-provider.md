# RA5 多 Provider + 双栏设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把硬编码单一 anthropic 的 modal 设置，改造成应用内双栏设置面 + 多 provider 管理（每 provider 多 model 名、可从 /models 端点拉取）、baseUrl、默认 provider 播种。

**Architecture:** 后端增量小（`providers.models` JSON 列 + 拉模型模块 + 一个 IPC + 默认播种）；主体在渲染层双栏 UI（全窗覆盖，复用 `settings-store.open`，reader 不卸载）。模型解析层 `resolveAssistantModel`/`model-factory` 与 `assistants.model`（text）**零改动**。

**Tech Stack:** Electron 41 + React 19 + Zustand + Zod 4 + Drizzle/better-sqlite3 + shadcn(Base UI) Select + vitest（Electron 运行时）。

**前置约定（每个 commit 都遵守）：**

- Conventional Commits；末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 提交用 `git commit --no-verify`；提交前手动 `pnpm typecheck` + 相关 `pnpm test` 绿。
- 当前分支 `feat/ra5-multi-provider`，**不要切分支**。
- 测试文件 `.test.ts`（vitest include 不含 `.tsx`）；测试用 `pnpm test`（绝不 node/npx/bunx，要 `pnpm`/`pnpx`）。
- React Compiler 已启用：**不写**手动 `useCallback`/`useMemo`；effect 命令式清理仍手写。
- UI 样式走 Tailwind 工具类，禁内联 `style={{}}`（运行时计算值除外）。

---

## File Structure

**新建**

- `src/main/providers/default-providers.ts` — `DEFAULT_PROVIDERS` 配置 + `seedDefaultProviders(db)`。
- `src/main/providers/provider-models.ts` — `buildModelsRequest` / `adaptModelsResponse`（含 Zod 响应 schema）/ `fetchProviderModels` / 错误映射。
- `src/renderer/settings/settings-logic.ts` — 纯 UI 逻辑（`providerFormToUpsertInput` / `mergeModels` / `assistantModelOptions`）。
- `src/renderer/settings/SettingsShell.tsx` / `ModelsSettings.tsx` / `AppearanceSettings.tsx` / `ReadingSettings.tsx` / `ProviderCard.tsx` / `ProviderForm.tsx` / `ModelEditor.tsx` / `AssistantModelPicker.tsx`。
- `src/renderer/components/ui/select.tsx` — shadcn 生成。

**修改**

- `src/main/db/schema.ts`（providers.models 列）+ `db:generate` 迁移。
- `src/shared/providers.ts`（models / DEFAULT_BASE_URL / PROVIDER_TYPE_LABEL / listModels\*）+ `providers.test.ts`。
- `src/shared/ipc.ts`（providersListModels）。
- `src/main/providers/repository.ts`（toDto/upsert models）+ `repository.test.ts`。
- `src/main/ipc/settings-handlers.ts`（list-models handler）。
- `src/main/db/instance.ts`（seed 调用）。
- `src/preload.ts`（providers.reveal + providers.listModels）。
- `src/renderer/store/settings-store.ts`（activeCategory）。
- `src/renderer/App.tsx` + 旧 `src/renderer/settings/SettingsPanel.tsx`（替换为 SettingsShell）。
- `docs/superpowers/ROADMAP.md`。

---

### Task 1: `providers.models` JSON 列 + 迁移

**Files:** Modify `src/main/db/schema.ts`; generate migration under `src/main/db/migrations/`.

- [ ] **Step 1: 加列**

`src/main/db/schema.ts` 的 `providers` 表，在 `apiKeyEncrypted` 行后、`createdAt` 前加：

```ts
    apiKeyEncrypted: blob("api_key_encrypted", { mode: "buffer" }),
    models: text("models", { mode: "json" }).$type<string[]>(),
    createdAt: nowMs(),
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新增 `src/main/db/migrations/<timestamp>_<name>/`（含 `migration.sql` 加 `ALTER TABLE providers ADD ... models`、`snapshot.json`）。**不要手编**迁移文件。

- [ ] **Step 3: 验证（迁移可跑、无回归）**

Run: `pnpm typecheck` → 0 errors。
Run: `pnpm test` → 全绿（既有 provider 仓储测试经 `runMigrations` 跑到新迁移；`row.models` 暂未被消费，不破坏）。

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit --no-verify -m "$(cat <<'EOF'
feat(db): add providers.models json column

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: shared provider-type 元数据 + 拉模型契约

**Files:** Modify `src/shared/providers.ts`; Test `src/shared/providers.test.ts`.

- [ ] **Step 1: 写失败测试**

在 `src/shared/providers.test.ts` 末尾（`describe` 内）追加（若文件无总 describe，整体包一层；按现有结构插 `it`）：

```ts
import {
  DEFAULT_BASE_URL,
  PROVIDER_TYPE_LABEL,
  listModelsInput,
  listModelsResult,
  providerType,
} from "@shared/providers";

describe("provider-type metadata", () => {
  it("DEFAULT_BASE_URL covers every provider type", () => {
    expect(Object.keys(DEFAULT_BASE_URL).sort()).toEqual([...providerType.options].sort());
    expect(DEFAULT_BASE_URL["openai-compatible"]).toBeNull();
    expect(DEFAULT_BASE_URL.openai).toContain("https://");
  });
  it("PROVIDER_TYPE_LABEL covers every type with the agreed names", () => {
    expect(Object.keys(PROVIDER_TYPE_LABEL).sort()).toEqual([...providerType.options].sort());
    expect(PROVIDER_TYPE_LABEL.openai).toBe("OpenAI Responses");
    expect(PROVIDER_TYPE_LABEL["openai-compatible"]).toBe("OpenAI Chat Completions");
  });
});

describe("listModels contracts", () => {
  it("listModelsInput accepts ephemeral key and id forms", () => {
    expect(listModelsInput.safeParse({ type: "openai", apiKey: "sk-x" }).success).toBe(true);
    expect(listModelsInput.safeParse({ type: "anthropic", id: "p1" }).success).toBe(true);
    expect(listModelsInput.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("listModelsResult is a discriminated union on ok", () => {
    expect(listModelsResult.safeParse({ ok: true, models: ["a"] }).success).toBe(true);
    expect(listModelsResult.safeParse({ ok: false, message: "x", status: 401 }).success).toBe(true);
    expect(listModelsResult.safeParse({ ok: false }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/providers.test.ts`
Expected: FAIL（`DEFAULT_BASE_URL` 等未导出）。

- [ ] **Step 3: 实现**

在 `src/shared/providers.ts`（`providerType` 定义之后）加：

```ts
/** 各 type 官方默认端点：UI baseUrl 占位符 + 拉模型兜底共用（不注入生成路径——那交 SDK 自带默认）。 */
export const DEFAULT_BASE_URL: Record<ProviderType, string | null> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "openai-compatible": null,
};

/** provider type 的 UI 显示名（枚举值不变；按其讲的 API 命名）。 */
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai: "OpenAI Responses",
  "openai-compatible": "OpenAI Chat Completions",
  anthropic: "Anthropic",
  google: "Google Gemini",
};
```

在文件末尾加（`revealResult` 等附近）：

```ts
/** 列 provider 可用模型入参：key 解析 = 表单现填 apiKey ?? 由 id 解密的存储 key。 */
export const listModelsInput = z.object({
  type: providerType,
  baseUrl: z.string().min(1).nullish(),
  apiKey: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});
export type ListModelsInput = z.infer<typeof listModelsInput>;

export const listModelsResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type ListModelsResult = z.infer<typeof listModelsResult>;
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm test src/shared/providers.test.ts` → PASS
Run: `pnpm typecheck` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): add type metadata + listModels contracts (shared)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `providers.models` 端到端（DTO + upsert 入参 + 仓储）

**Files:** Modify `src/shared/providers.ts`, `src/main/providers/repository.ts`; Test `src/main/providers/repository.test.ts`, `src/shared/providers.test.ts`.

> DTO 与 toDto 必须同任务改（否则 typecheck 红）。

- [ ] **Step 1: 写失败测试**

`src/shared/providers.test.ts` 追加：

```ts
it("upsertProviderInput accepts optional models array", () => {
  expect(setUp({ type: "openai", models: ["gpt-4o", "gpt-4o-mini"] })).toBe(true);
  expect(setUp({ type: "openai", models: [""] })).toBe(false); // 空串非法
});
// 辅助（若文件无）：const setUp = (v: unknown) => upsertProviderInput.safeParse(v).success;
```

`src/main/providers/repository.test.ts` 追加（沿用其 `freshDb()` + `fakeEncryptor`，复制现有测试里构造 encryptor 的方式）：

```ts
it("upsert sets models; omit preserves; [] clears; toDto returns [] for null", () => {
  const db = freshDb();
  const enc = /* 复用本文件现有的 encryptor 实例 */ makeEnc();
  const a = upsertProvider(db, enc, { type: "openai", models: ["gpt-4o"] });
  expect(a.models).toEqual(["gpt-4o"]);
  const b = upsertProvider(db, enc, { id: a.id, type: "openai" }); // 省略 models
  expect(b.models).toEqual(["gpt-4o"]); // 保留
  const c = upsertProvider(db, enc, { id: a.id, type: "openai", models: [] }); // 清空
  expect(c.models).toEqual([]);
  // 新建省略 models → []
  const d = upsertProvider(db, enc, { type: "anthropic" });
  expect(d.models).toEqual([]);
});
```

> 若 repository.test.ts 现有 `getAllPreferences`-style encryptor 构造不同，照该文件已有写法构造 `enc`；本步只新增上面这个 `it`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/providers/repository.test.ts src/shared/providers.test.ts`
Expected: FAIL（`upsertProviderInput` 无 models；`ProviderDto.models` 不存在；toDto 不返 models）。

- [ ] **Step 3: 实现**

`src/shared/providers.ts`：

- `ProviderDto` 加 `models: string[];`（在 `key` 行附近）。
- `upsertProviderInput` 的 `.object({...})` 加 `models: z.array(z.string().min(1)).optional(),`（在 `apiKey` 行后；`.refine(...)` 不变）。

`src/main/providers/repository.ts`：

- `toDto` 返回对象加 `models: row.models ?? [],`。
- `upsertProvider` 的 **update** 分支 `.set({...})` 加 `...(input.models !== undefined ? { models: input.models } : {}),`。
- `upsertProvider` 的 **insert** 分支 `.values({...})` 加 `models: input.models ?? [],`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm test src/main/providers/repository.test.ts src/shared/providers.test.ts` → PASS
Run: `pnpm typecheck` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts src/main/providers/repository.ts src/main/providers/repository.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): persist per-provider model list (providers.models)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 默认 provider 播种

**Files:** Create `src/main/providers/default-providers.ts` (+ test `default-providers.test.ts`); Modify `src/main/db/instance.ts`.

- [ ] **Step 1: 写失败测试**

`src/main/providers/default-providers.test.ts`（仿 repository.test.ts 的 freshDb）：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
import { DEFAULT_PROVIDERS, seedDefaultProviders } from "@main/providers/default-providers";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("seedDefaultProviders", () => {
  it("seeds the defaults into an empty table", () => {
    const db = freshDb();
    seedDefaultProviders(db);
    const rows = db.select().from(providers).all();
    expect(rows).toHaveLength(DEFAULT_PROVIDERS.length);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.openai.label).toBe("OpenAI");
    expect(byType.openai.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(byType.openai.apiKeyEncrypted).toBeNull();
    expect(byType.openai.baseUrl).toBeNull();
    expect(byType.anthropic.type).toBe("anthropic");
    expect(byType.google.label).toBe("Gemini");
  });

  it("is a no-op when the table is non-empty", () => {
    const db = freshDb();
    db.insert(providers).values({ type: "openai", label: "mine" }).run();
    seedDefaultProviders(db);
    expect(db.select().from(providers).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/providers/default-providers.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/main/providers/default-providers.ts`**

```ts
import type { DB } from "@main/db/client";
import { providers } from "@main/db/schema";
import type { ProviderType } from "@shared/providers";

/** 初始态预置的默认 provider（不含 openai-compatible——用户手动加）。models 为预填常用起始型号；
 *  baseUrl=null（用各 type 默认端点）、无 apiKey。型号可被用户编辑/拉取覆盖。配置单独存放、单一源。 */
export const DEFAULT_PROVIDERS: { type: ProviderType; label: string; models: string[] }[] = [
  { type: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  {
    type: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  { type: "google", label: "Gemini", models: ["gemini-1.5-flash", "gemini-1.5-pro"] },
];

/** 空列表就播种：providers 表为空时插入默认；非空则 no-op（不重复、不扰现有）。 */
export function seedDefaultProviders(db: DB): void {
  const existing = db.select({ id: providers.id }).from(providers).limit(1).all();
  if (existing.length > 0) return;
  for (const p of DEFAULT_PROVIDERS) {
    db.insert(providers).values({ type: p.type, label: p.label, models: p.models }).run();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/providers/default-providers.test.ts` → PASS（2）

- [ ] **Step 5: 接入 `initDb`**

`src/main/db/instance.ts`：import 并在 `runMigrations(...)` 之后、`resetStuckSummaries` 旁调用：

```ts
import { seedDefaultProviders } from "@main/providers/default-providers";
// ...
runMigrations(candidate, migrationsFolder);
seedDefaultProviders(candidate); // 空表则播种默认 provider（OpenAI/Anthropic/Gemini）
resetStuckSummaries(candidate);
```

Run: `pnpm typecheck` → 0 errors；`pnpm test` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/default-providers.ts src/main/providers/default-providers.test.ts src/main/db/instance.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): seed default providers (OpenAI/Anthropic/Gemini) when empty

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 拉模型——请求构造 + 响应归一（纯，Zod 边界校验）

**Files:** Create `src/main/providers/provider-models.ts` (+ test).

> 本任务只做两个纯步骤（无 fetch）：`buildModelsRequest` 与 `adaptModelsResponse`。fetch 编排留 Task 6。

- [ ] **Step 1: 写失败测试** — `src/main/providers/provider-models.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildModelsRequest, adaptModelsResponse } from "@main/providers/provider-models";

describe("buildModelsRequest", () => {
  it("openai: /models with Bearer; default base", () => {
    const r = buildModelsRequest("openai", null, "sk-x");
    expect(r.url).toBe("https://api.openai.com/v1/models");
    expect(r.headers.Authorization).toBe("Bearer sk-x");
  });
  it("anthropic: /v1/models with x-api-key + version", () => {
    const r = buildModelsRequest("anthropic", null, "sk-y");
    expect(r.url).toBe("https://api.anthropic.com/v1/models");
    expect(r.headers["x-api-key"]).toBe("sk-y");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
  });
  it("google: /models?key=", () => {
    const r = buildModelsRequest("google", null, "k1");
    expect(r.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=k1");
  });
  it("openai-compatible: uses given base; throws when base missing", () => {
    expect(buildModelsRequest("openai-compatible", "https://gw/v1", "sk-z").url).toBe(
      "https://gw/v1/models",
    );
    expect(() => buildModelsRequest("openai-compatible", null, "sk-z")).toThrow();
  });
});

describe("adaptModelsResponse", () => {
  it("openai/anthropic: data[].id", () => {
    expect(
      adaptModelsResponse("openai", { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    ).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(adaptModelsResponse("anthropic", { data: [{ id: "claude-3-5-haiku-latest" }] })).toEqual(
      ["claude-3-5-haiku-latest"],
    );
  });
  it("google: strips models/ prefix and filters generateContent", () => {
    const json = {
      models: [
        { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    };
    expect(adaptModelsResponse("google", json)).toEqual(["gemini-1.5-flash"]);
  });
  it("strict types throw on malformed response", () => {
    expect(() => adaptModelsResponse("openai", { foo: 1 })).toThrow();
    expect(() => adaptModelsResponse("anthropic", { data: "x" })).toThrow();
  });
  it("openai-compatible best-effort: salvages valid ids, tolerates junk, [] when no data", () => {
    expect(
      adaptModelsResponse("openai-compatible", { data: [{ id: "a", extra: 1 }, { noId: true }] }),
    ).toEqual(["a"]);
    expect(adaptModelsResponse("openai-compatible", { whatever: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/providers/provider-models.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/main/providers/provider-models.ts`（本任务部分）**

```ts
import { z } from "zod";
import { DEFAULT_BASE_URL, type ProviderType } from "@shared/providers";

export interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/** 按 type 构造 /models 请求（url + 鉴权头）。base = baseUrl ?? 默认端点；openai-compatible 无默认必须给 base。 */
export function buildModelsRequest(
  type: ProviderType,
  baseUrl: string | null,
  apiKey: string,
): ModelsRequest {
  const base = baseUrl ?? DEFAULT_BASE_URL[type];
  if (!base) throw new Error("baseUrl is required for this provider");
  switch (type) {
    case "openai":
    case "openai-compatible":
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic":
      return {
        url: `${base}/v1/models`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      };
    case "google":
      return { url: `${base}/models?key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
}

const openaiLike = z.object({ data: z.array(z.object({ id: z.string() })) });
const googleSchema = z.object({
  models: z.array(
    z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() }),
  ),
});
const looseItem = z.object({ id: z.string() }).passthrough();

/** 先 Zod 校验外部响应（API 边界），再按 type 归一为 model id 列表。openai-compatible 放宽 best-effort。 */
export function adaptModelsResponse(type: ProviderType, json: unknown): string[] {
  if (type === "google") {
    return googleSchema
      .parse(json)
      .models.filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
      .map((m) => m.name.replace(/^models\//, ""));
  }
  if (type === "openai-compatible") {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data.flatMap((it) => {
      const p = looseItem.safeParse(it);
      return p.success ? [p.data.id] : [];
    });
  }
  // openai / anthropic：严格 data[].id
  return openaiLike.parse(json).data.map((m) => m.id);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/providers/provider-models.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-models.ts src/main/providers/provider-models.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): per-type models request builder + response adapter (zod)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 拉模型——`fetchProviderModels` 编排 + 错误映射

**Files:** Modify `src/main/providers/provider-models.ts`; Test same `provider-models.test.ts`.

- [ ] **Step 1: 写失败测试** — 追加：

```ts
import { fetchProviderModels, mapModelsError } from "@main/providers/provider-models";

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
  const status = init?.status ?? 200;
  return {
    ok: init?.ok ?? status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("fetchProviderModels", () => {
  it("returns adapted ids on 200", async () => {
    const fetchImpl = async () => jsonResponse({ data: [{ id: "gpt-4o" }] });
    await expect(
      fetchProviderModels(
        { type: "openai", baseUrl: null, apiKey: "sk" },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toEqual(["gpt-4o"]);
  });
  it("throws with provider message on non-2xx", async () => {
    const fetchImpl = async () =>
      jsonResponse({ error: { message: "bad key" } }, { status: 401, ok: false });
    await expect(
      fetchProviderModels(
        { type: "openai", baseUrl: null, apiKey: "x" },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow("bad key");
  });
});

describe("mapModelsError", () => {
  it("transparent provider message wins", () => {
    expect(mapModelsError(new Error("boom"), undefined).message).toContain("boom");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/providers/provider-models.test.ts`
Expected: FAIL（`fetchProviderModels`/`mapModelsError` 未导出）。

- [ ] **Step 3: 实现（追加到 `provider-models.ts`）**

```ts
export interface FetchModelsParams {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string;
}

/** HTTP 状态码标准语义兜底（标「可能方向」，绝不编造）；与 ai-sdk-tester 同款。 */
const HTTP_HINT: Record<number, string> = {
  400: "Bad Request — the request may be rejected",
  401: "Unauthorized — the API key may be invalid or missing",
  403: "Forbidden — access denied",
  404: "Not Found — the endpoint or base URL may be wrong",
  429: "Too Many Requests — rate limited or quota exhausted",
};

/** 把抛出/非 2xx 响应映射为可读 message（优先透传 provider 原文，提不到退 HTTP 语义）。 */
export function mapModelsError(
  err: unknown,
  status: number | undefined,
): { status?: number; message: string } {
  const fromErr = err instanceof Error ? err.message : err ? String(err) : "";
  if (fromErr) return { status, message: fromErr };
  if (status && HTTP_HINT[status])
    return { status, message: `HTTP ${status}: ${HTTP_HINT[status]}` };
  if (status) return { status, message: `HTTP ${status}` };
  return { message: "Request failed" };
}

/** 从错误响应体尽力提真实 message（{error:{message}} / {error:"str"} / {message}）；提不到返 null。 */
function extractBodyMessage(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const e = o.error;
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (typeof o.message === "string" && o.message.trim()) return o.message;
  return null;
}

/** 调 provider /models 端点 → model id 列表。失败抛 Error（message 已透传 provider 原文或 HTTP 语义）。 */
export async function fetchProviderModels(
  p: FetchModelsParams,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const req = buildModelsRequest(p.type, p.baseUrl, p.apiKey);
  const res = await fetchImpl(req.url, { method: "GET", headers: req.headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = extractBodyMessage(body) ?? mapModelsError(undefined, res.status).message;
    throw new Error(message);
  }
  return adaptModelsResponse(p.type, body);
}
```

> `fetchProviderModels` 自身的 throw（网络层）由调用方（Task 7 handler）try/catch + `mapModelsError` 映射为 `ListModelsResult`；本函数对**非 2xx**已透传 provider message。

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm test src/main/providers/provider-models.test.ts` → PASS
Run: `pnpm typecheck` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-models.ts src/main/providers/provider-models.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): fetchProviderModels with honest error mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: IPC `providers:list-models` + preload（含 reveal 补漏）

**Files:** Modify `src/shared/ipc.ts`, `src/main/ipc/settings-handlers.ts`, `src/preload.ts`.

> 无单测（IPC/preload 接线）；验收 = typecheck + 既有 test 绿。

- [ ] **Step 1: 通道名** — `src/shared/ipc.ts` 在 `assistantUpdate` 行后加：

```ts
  providersListModels: "providers:list-models",
```

- [ ] **Step 2: handler** — `src/main/ipc/settings-handlers.ts`：

import 增补：

```ts
import { net } from "electron";
import { listModelsInput, type ListModelsInput, type ListModelsResult } from "@shared/providers";
import { fetchProviderModels, mapModelsError } from "@main/providers/provider-models";
```

（`@shared/providers` 已 import，合并新增的 `listModelsInput`/`ListModelsInput`/`ListModelsResult`；`revealProviderKey` 已从 repository import。）

在 `registerSettingsHandlers()` 内加：

```ts
handle<ListModelsInput, ListModelsResult>(
  IPC.providersListModels,
  listModelsInput,
  async (input) => {
    let apiKey: string;
    try {
      apiKey = input.apiKey ?? revealProviderKey(getDb(), safeStorageEncryptor, input.id ?? "");
    } catch {
      return { ok: false, message: "No API key available for this provider" };
    }
    try {
      const models = await fetchProviderModels(
        { type: input.type, baseUrl: input.baseUrl ?? null, apiKey },
        net.fetch,
      );
      return { ok: true, models };
    } catch (err) {
      const status = undefined;
      return { ok: false, ...mapModelsError(err, status) };
    }
  },
);
```

> 注：`handle` 支持 async fn（返回 Promise）；若其类型签名不接受异步，照 `aiSdkTester`/`providersTest` 已有的 async handler 写法（那条也是 `Promise<TestResult>`）对齐。

- [ ] **Step 3: preload** — `src/preload.ts` 的 `settings.providers` 块补 `reveal` 与 `listModels`：

import 增补 `RevealResult`、`ListModelsInput`、`ListModelsResult`（从 `@shared/providers`）。块改为：

```ts
    providers: {
      list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(IPC.providersList),
      upsert: (input: UpsertProviderInput): Promise<ProviderDto> =>
        ipcRenderer.invoke(IPC.providersUpsert, input),
      reveal: (input: ProviderIdInput): Promise<RevealResult> =>
        ipcRenderer.invoke(IPC.providersReveal, input),
      test: (input: TestProviderInput): Promise<TestResult> =>
        ipcRenderer.invoke(IPC.providersTest, input),
      remove: (input: ProviderIdInput): Promise<void> =>
        ipcRenderer.invoke(IPC.providersRemove, input),
      listModels: (input: ListModelsInput): Promise<ListModelsResult> =>
        ipcRenderer.invoke(IPC.providersListModels, input),
    },
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck` → 0 errors（含 preload 的 `RevealResult`/`ProviderIdInput` import 完整）。
Run: `pnpm test` → 全绿。
Run: `pnpm lint` → 0 errors。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/settings-handlers.ts src/preload.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(providers): providers:list-models IPC + expose reveal/listModels in preload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: shadcn `select` 原语

**Files:** Create `src/renderer/components/ui/select.tsx`; possibly `package.json`/`pnpm-lock.yaml`.

- [ ] **Step 1: 生成**

Run: `pnpx shadcn@latest add select -y`
Expected: 生成 `src/renderer/components/ui/select.tsx`（Base UI Select）。`postinstall` 自动 `db:rebuild:electron`（若装了依赖）。

> base-nova registry 无 select 时：手搓基于 `@base-ui/react/select` 的薄封装（参考既有 `tabs.tsx`/`toggle-group.tsx` 的 cva+cn 写法），导出 `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`。

- [ ] **Step 2: 验证 ABI + 读 API**

Run: `pnpm test src/main/app-service.test.ts` → PASS（确认 better-sqlite3 仍 Electron ABI；失败则 `pnpm db:rebuild:electron`）。
Run: `cat src/renderer/components/ui/select.tsx` → 记下导出名与 value/onValueChange 形态（Base UI Select 的单值 API），供后续组件接线。
Run: `pnpm typecheck && pnpm lint` → 0/0。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ui/select.tsx package.json pnpm-lock.yaml
git commit --no-verify -m "$(cat <<'EOF'
feat(ui): add shadcn Select (Base UI) primitive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 设置 store activeCategory + UI 纯逻辑助手

**Files:** Modify `src/renderer/store/settings-store.ts`; Create `src/renderer/settings/settings-logic.ts` (+ test).

- [ ] **Step 1: 写失败测试** — `src/renderer/settings/settings-logic.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  mergeModels,
  assistantModelOptions,
  providerFormToUpsertInput,
} from "@renderer/settings/settings-logic";

describe("mergeModels", () => {
  it("unions and dedups, preserving order", () => {
    expect(mergeModels(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("assistantModelOptions", () => {
  it("includes current model even if not in the provider list", () => {
    expect(assistantModelOptions(["a", "b"], "x")).toEqual(["a", "b", "x"]);
    expect(assistantModelOptions(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(assistantModelOptions(["a"], null)).toEqual(["a"]);
  });
});

describe("providerFormToUpsertInput", () => {
  it("omits apiKey when not re-keyed; empty baseUrl -> null; passes models", () => {
    const out = providerFormToUpsertInput({
      id: "p1",
      type: "openai",
      label: "L",
      baseUrl: "",
      apiKey: "",
      models: ["gpt-4o"],
    });
    expect(out).toEqual({
      id: "p1",
      type: "openai",
      label: "L",
      baseUrl: null,
      models: ["gpt-4o"],
    });
  });
  it("includes apiKey when provided; label null when empty", () => {
    const out = providerFormToUpsertInput({
      id: undefined,
      type: "anthropic",
      label: "",
      baseUrl: "https://x",
      apiKey: "sk-1",
      models: [],
    });
    expect(out).toEqual({
      type: "anthropic",
      label: null,
      baseUrl: "https://x",
      apiKey: "sk-1",
      models: [],
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/renderer/settings/settings-logic.ts`**

```ts
import type { ProviderType, UpsertProviderInput } from "@shared/providers";

export interface ProviderFormState {
  id: string | undefined; // 有=编辑，无=新建
  type: ProviderType;
  label: string;
  baseUrl: string;
  apiKey: string; // 空=不改 key（编辑保留 / 新建无 key）
  models: string[];
}

/** 并集去重、保序。 */
export function mergeModels(existing: string[], add: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const m of add) if (!seen.has(m)) (seen.add(m), out.push(m));
  return out;
}

/** assistant 的 model 下拉选项：provider 的 models ∪ {当前已存 model（若不在列表）}。 */
export function assistantModelOptions(providerModels: string[], current: string | null): string[] {
  if (current && !providerModels.includes(current)) return [...providerModels, current];
  return providerModels;
}

/** 表单态 → upsert IPC 入参：空 baseUrl→null、空 label→null、空 apiKey 省略（不改 key）、id 省略=新建。 */
export function providerFormToUpsertInput(f: ProviderFormState): UpsertProviderInput {
  const out: UpsertProviderInput = {
    type: f.type,
    label: f.label.trim() ? f.label.trim() : null,
    baseUrl: f.baseUrl.trim() ? f.baseUrl.trim() : null,
    models: f.models,
  };
  if (f.id) out.id = f.id;
  if (f.apiKey.trim()) out.apiKey = f.apiKey.trim();
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts` → PASS

- [ ] **Step 5: settings-store 加 activeCategory**

`src/renderer/store/settings-store.ts` 改为：

```ts
import { create } from "zustand";

export type SettingsCategory = "models" | "appearance" | "reading";

interface SettingsState {
  open: boolean;
  activeCategory: SettingsCategory;
  testResult: { ok: boolean; message?: string } | null;
}
interface SettingsActions {
  setOpen: (open: boolean) => void;
  setActiveCategory: (c: SettingsCategory) => void;
  setTestResult: (result: SettingsState["testResult"]) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  activeCategory: "models",
  testResult: null,
  setOpen: (open) => set({ open }),
  setActiveCategory: (activeCategory) => set({ activeCategory }),
  setTestResult: (testResult) => set({ testResult }),
}));
```

Run: `pnpm typecheck` → 0 errors（注意：旧 `SettingsPanel.tsx` 仍引用 store，本步不破坏其用到的字段）。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/settings-store.ts src/renderer/settings/settings-logic.ts src/renderer/settings/settings-logic.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): activeCategory + pure form/model logic helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 双栏外壳 + 外观/阅读分类

**Files:** Create `src/renderer/settings/SettingsShell.tsx`, `AppearanceSettings.tsx`, `ReadingSettings.tsx`.

> UI 组件，无单测；验收 = typecheck + lint。完整行为在 Task 13 接线后 + Task 14 GUI smoke 验。

- [ ] **Step 1: `AppearanceSettings.tsx`** — 把旧 modal 的颜色模式 ToggleGroup 段搬来（复用 `useThemeStore`、`ToggleGroup`/`ToggleGroupItem`、Sun/Monitor/Moon、`colorModeSchema.safeParse` 收窄，见旧 `SettingsPanel.tsx` 现有实现），包一个右栏容器：

```tsx
import { Monitor, Moon, Sun } from "lucide-react";
import { colorMode as colorModeSchema } from "@shared/preferences";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { useThemeStore } from "@renderer/store/theme-store";

export function AppearanceSettings() {
  const colorMode = useThemeStore((s) => s.colorMode);
  const setColorMode = useThemeStore((s) => s.setColorMode);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">外观</h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">颜色模式</span>
        <ToggleGroup
          value={[colorMode]}
          onValueChange={(g) => {
            const parsed = colorModeSchema.safeParse(g[0]);
            if (parsed.success) setColorMode(parsed.data);
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="light" aria-label="浅色">
            <Sun />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="跟随系统">
            <Monitor />
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="深色">
            <Moon />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: `ReadingSettings.tsx`** — 把旧 modal 的「开章自动生成摘要」段搬来（复用 `usePrefsStore`、`Checkbox`）：

```tsx
import { Checkbox } from "@renderer/components/ui/checkbox";
import { usePrefsStore } from "@renderer/store/prefs-store";

export function ReadingSettings() {
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">阅读</h2>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="auto-summarize" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">开章自动生成本章摘要</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            打开 / 切换章节时后台生成本章摘要，就绪后随提问一并提供给 AI（会产生模型调用）。
          </span>
        </label>
        <Checkbox
          id="auto-summarize"
          checked={autoSummarize}
          onCheckedChange={setAutoSummarize}
          className="mt-0.5"
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 3: `SettingsShell.tsx`** — 全窗覆盖双栏壳；左栏分类导航，右栏按 `activeCategory` 渲染。`ModelsSettings` 在 Task 13 建好前先用占位（Task 13 替换）。Esc / ✕ 关闭。

```tsx
import { X } from "lucide-react";
import { useEffect } from "react";
import { useSettingsStore, type SettingsCategory } from "@renderer/store/settings-store";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ModelsSettings } from "./ModelsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ReadingSettings } from "./ReadingSettings";

const CATEGORIES: { key: SettingsCategory; label: string }[] = [
  { key: "models", label: "模型" },
  { key: "appearance", label: "外观" },
  { key: "reading", label: "阅读" },
];

export function SettingsShell() {
  const open = useSettingsStore((s) => s.open);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const active = useSettingsStore((s) => s.activeCategory);
  const setActive = useSettingsStore((s) => s.setActiveCategory);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex bg-background font-sans">
      <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-3">
        <div className="mb-2 px-2 font-serif text-base font-semibold">设置</div>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-left text-sm",
              active === c.key ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            {c.label}
          </button>
        ))}
      </nav>
      <div className="relative min-w-0 flex-1 overflow-y-auto p-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(false)}
          className="absolute right-4 top-4"
          aria-label="关闭设置"
        >
          <X />
        </Button>
        <div className="mx-auto max-w-2xl">
          {active === "models" && <ModelsSettings />}
          {active === "appearance" && <AppearanceSettings />}
          {active === "reading" && <ReadingSettings />}
        </div>
      </div>
    </div>
  );
}
```

> `Button` 的 `size="icon"` 若不存在，用 `size="sm"`；以生成的 button.tsx 实际 variants 为准。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck` → 此时 `ModelsSettings` 尚未建 → 预期 TS 报「找不到 ./ModelsSettings」。**本任务允许该一处缺失**——Task 13 建好即消。为让本任务自洽，先建一个最小占位 `src/renderer/settings/ModelsSettings.tsx`：`export function ModelsSettings() { return <section>模型（建设中）</section>; }`，使 typecheck/lint 绿。Task 13 再实装。
Run: `pnpm typecheck && pnpm lint` → 0/0。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings/SettingsShell.tsx src/renderer/settings/AppearanceSettings.tsx src/renderer/settings/ReadingSettings.tsx src/renderer/settings/ModelsSettings.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): two-column settings shell + appearance/reading panes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: ProviderCard + AssistantModelPicker

**Files:** Create `src/renderer/settings/ProviderCard.tsx`, `AssistantModelPicker.tsx`.

> UI；验收 typecheck+lint。用 `@tanstack/react-query`（项目已用：见旧 SettingsPanel 的 useQuery/useMutation）+ `window.api.settings.*` + `qk` keys（`src/renderer/query/keys.ts` 已有 `providers`/`assistantDefault`）。

- [ ] **Step 1: `ProviderCard.tsx`** — 展示单个 provider + 操作回调（编辑/测试/移除由父组件处理；卡只展示 + 触发回调）：

```tsx
import { Pencil, PlugZap, Trash2 } from "lucide-react";
import type { ProviderDto } from "@shared/providers";
import { PROVIDER_TYPE_LABEL } from "@shared/providers";
import { Button } from "@renderer/components/ui/button";

function keyText(p: ProviderDto): string {
  if (p.key.status === "set") return p.key.mask;
  if (p.key.status === "undecryptable") return "本机无法解密";
  return "未配置";
}

export function ProviderCard({
  provider,
  onEdit,
  onTest,
  onRemove,
}: {
  provider: ProviderDto;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
            {PROVIDER_TYPE_LABEL[provider.type]}
          </span>
          <span className="ml-2 text-sm font-medium">{provider.label ?? "（未命名）"}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="编辑">
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onTest} aria-label="测试">
            <PlugZap className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="移除">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {provider.baseUrl && <div className="truncate">⛓ {provider.baseUrl}</div>}
        <span>🔑 {keyText(provider)}</span>
        <span className="ml-2">· {provider.models.length} 个模型</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `AssistantModelPicker.tsx`** — provider 下拉 + model 下拉 + 测试连接 → 写 assistant。用生成的 `Select`（Task 8 的实际 API；下面按典型 shadcn Select 写，按生成文件调整）：

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { PROVIDER_TYPE_LABEL } from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useSettingsStore } from "@renderer/store/settings-store";
import { assistantModelOptions } from "./settings-logic";

export function AssistantModelPicker() {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
  });
  const testResult = useSettingsStore((s) => s.testResult);
  const setTestResult = useSettingsStore((s) => s.setTestResult);

  const providerId = assistant.data?.providerId ?? "";
  const model = assistant.data?.model ?? "";
  const selected = providers.data?.find((p) => p.id === providerId) ?? null;
  const modelOptions = assistantModelOptions(selected?.models ?? [], model || null);

  const save = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string }) =>
      window.api.settings.assistant.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assistantDefault }),
  });
  const test = useMutation({
    mutationFn: () => window.api.settings.providers.test({ id: providerId, model }),
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">对话模型</h3>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">Provider</span>
        <Select value={providerId} onValueChange={(id) => save.mutate({ providerId: id })}>
          <SelectTrigger>
            <SelectValue placeholder="选择 provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {PROVIDER_TYPE_LABEL[p.type]} · {p.label ?? "（未命名）"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">模型</span>
        <Select value={model} onValueChange={(m) => save.mutate({ model: m })}>
          <SelectTrigger>
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!providerId || !model || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "测试中…" : "测试连接"}
        </Button>
        {testResult && (
          <span
            className={
              testResult.ok
                ? "flex items-center gap-1 text-sm text-primary"
                : "flex items-center gap-1 text-sm text-destructive"
            }
          >
            {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
            {testResult.ok ? "连接成功" : `失败：${testResult.message ?? ""}`}
          </span>
        )}
      </div>
    </section>
  );
}
```

> Select 的实际 prop 名（value/onValueChange/单选）以 Task 8 生成文件为准；若是 Base UI 数组式，按 toggle-group 同款适配（`value={[providerId]}` + `onValueChange={(g)=>…g[0]}`）。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint` → 0/0（`qk.providers`/`qk.assistantDefault` 已存在；若 key 名不同，按 `src/renderer/query/keys.ts` 实际名调整）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/ProviderCard.tsx src/renderer/settings/AssistantModelPicker.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): ProviderCard + assistant model picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: ProviderForm + ModelEditor（添加/编辑 + 拉模型）

**Files:** Create `src/renderer/settings/ModelEditor.tsx`, `ProviderForm.tsx`.

> 本任务是最复杂的 UI；逻辑已抽到 `settings-logic.ts`（Task 9，已测）。验收 typecheck+lint，行为 Task 14 GUI 验。

- [ ] **Step 1: `ModelEditor.tsx`** — 受控的 models 编辑器（已选列表 + 手动添加 + 拉取勾选）。props：当前 `models`、`onChange(models)`、以及拉取所需的 `type/baseUrl/apiKey/id`（来自表单态）。

```tsx
import { useState } from "react";
import { Download, Plus, X } from "lucide-react";
import type { ProviderType } from "@shared/providers";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { mergeModels } from "./settings-logic";

export function ModelEditor({
  models,
  onChange,
  type,
  baseUrl,
  apiKey,
  id,
}: {
  models: string[];
  onChange: (m: string[]) => void;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  id: string | undefined;
}) {
  const [manual, setManual] = useState("");
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function pull() {
    setErr(null);
    setLoading(true);
    setFetched(null);
    const res = await window.api.settings.providers.listModels({
      type,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || undefined,
      id,
    });
    setLoading(false);
    if (res.ok) {
      setFetched(res.models);
      setChecked(new Set(res.models));
    } else setErr(res.message);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">模型</span>
        <Button type="button" variant="outline" size="sm" onClick={pull} disabled={loading}>
          <Download className="size-4" /> {loading ? "拉取中…" : "拉取模型"}
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {fetched && (
        <div className="rounded-md border border-border p-2">
          {fetched.length === 0 && <p className="text-xs text-muted-foreground">（无模型）</p>}
          {fetched.map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
              <Checkbox
                checked={checked.has(m)}
                onCheckedChange={(v) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    v ? n.add(m) : n.delete(m);
                    return n;
                  })
                }
              />
              {m}
            </label>
          ))}
          <Button
            type="button"
            size="sm"
            className="mt-1"
            onClick={() => {
              onChange(mergeModels(models, [...checked]));
              setFetched(null);
            }}
          >
            添加所选
          </Button>
        </div>
      )}
      <ul className="space-y-1">
        {models.map((m) => (
          <li
            key={m}
            className="flex items-center justify-between rounded bg-muted/40 px-2 py-1 text-sm"
          >
            {m}
            <button
              type="button"
              aria-label="移除"
              onClick={() => onChange(models.filter((x) => x !== m))}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="手动添加模型名…"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (manual.trim()) {
              onChange(mergeModels(models, [manual.trim()]));
              setManual("");
            }
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `ProviderForm.tsx`** — 受控表单（type/label/baseUrl/apiKey/models）。新建用空初值，编辑用传入的 provider；保存调 upsert。

```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderDto, ProviderType } from "@shared/providers";
import { DEFAULT_BASE_URL, PROVIDER_TYPE_LABEL, providerType } from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { ModelEditor } from "./ModelEditor";
import { providerFormToUpsertInput, type ProviderFormState } from "./settings-logic";

function initial(p: ProviderDto | null): ProviderFormState {
  return {
    id: p?.id,
    type: p?.type ?? "openai",
    label: p?.label ?? "",
    baseUrl: p?.baseUrl ?? "",
    apiKey: "",
    models: p?.models ?? [],
  };
}

export function ProviderForm({
  provider,
  onDone,
}: {
  provider: ProviderDto | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<ProviderFormState>(() => initial(provider));
  const [editingKey, setEditingKey] = useState(provider == null || provider.key.status === "none");
  const baseRequired = f.type === "openai-compatible";

  const save = useMutation({
    mutationFn: () => window.api.settings.providers.upsert(providerFormToUpsertInput(f)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.providers });
      onDone();
    },
  });

  const canSave = !(baseRequired && !f.baseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">类型</span>
        <Select value={f.type} onValueChange={(v) => setF({ ...f, type: v as ProviderType })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerType.options.map((t) => (
              <SelectItem key={t} value={t}>
                {PROVIDER_TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">名称</span>
        <Input
          value={f.label}
          onChange={(e) => setF({ ...f, label: e.target.value })}
          placeholder="（可选）"
        />
        <span className="text-xs text-muted-foreground">baseURL</span>
        <Input
          value={f.baseUrl}
          onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
          placeholder={DEFAULT_BASE_URL[f.type] ?? "https://你的网关/v1（必填）"}
        />
        <span className="text-xs text-muted-foreground">API Key</span>
        {!editingKey && provider && provider.key.status !== "none" ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-sm text-muted-foreground">
              {provider.key.status === "set" ? provider.key.mask : "本机无法解密"}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
              编辑
            </Button>
          </div>
        ) : (
          <Input
            type="password"
            value={f.apiKey}
            onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            placeholder="sk-…"
          />
        )}
      </div>
      <ModelEditor
        models={f.models}
        onChange={(models) => setF({ ...f, models })}
        type={f.type}
        baseUrl={f.baseUrl}
        apiKey={f.apiKey}
        id={f.id}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint` → 0/0（Select API 以生成文件为准，必要时适配数组式）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/ModelEditor.tsx src/renderer/settings/ProviderForm.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): provider add/edit form + model editor with fetch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ModelsSettings 组合 + 接入 App + 移除旧 modal

**Files:** Modify `src/renderer/settings/ModelsSettings.tsx` (替换占位), `src/renderer/App.tsx`; Delete old `src/renderer/settings/SettingsPanel.tsx`.

- [ ] **Step 1: 实装 `ModelsSettings.tsx`** — 组合 AssistantModelPicker + Providers 列表 + 添加/编辑表单：

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { ProviderDto } from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { useSettingsStore } from "@renderer/store/settings-store";
import { AssistantModelPicker } from "./AssistantModelPicker";
import { ProviderCard } from "./ProviderCard";
import { ProviderForm } from "./ProviderForm";

export function ModelsSettings() {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const setTestResult = useSettingsStore((s) => s.setTestResult);
  const [editing, setEditing] = useState<ProviderDto | null | "new">(null); // null=无, "new"=新建, dto=编辑

  const remove = useMutation({
    mutationFn: (id: string) => window.api.settings.providers.remove({ id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.providers }),
  });
  const test = useMutation({
    mutationFn: (p: ProviderDto) =>
      window.api.settings.providers.test({ id: p.id, model: p.models[0] ?? "" }),
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  return (
    <section className="space-y-6">
      <h2 className="font-serif text-lg">模型</h2>
      <AssistantModelPicker />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Providers</h3>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> 添加
          </Button>
        </div>
        {editing === "new" && <ProviderForm provider={null} onDone={() => setEditing(null)} />}
        {providers.data?.map((p) =>
          editing !== "new" && (editing as ProviderDto | null)?.id === p.id ? (
            <ProviderForm key={p.id} provider={p} onDone={() => setEditing(null)} />
          ) : (
            <ProviderCard
              key={p.id}
              provider={p}
              onEdit={() => setEditing(p)}
              onTest={() => test.mutate(p)}
              onRemove={() => remove.mutate(p.id)}
            />
          ),
        )}
      </div>
    </section>
  );
}
```

> 卡片「测试」用该 provider 的首个 model（`models[0]`）；无 model 时 test 会因空 model 失败并显真实报错——可接受（用户应先加模型）。

- [ ] **Step 2: 接入 App，移除旧 modal** — `src/renderer/App.tsx`：把 `import { SettingsPanel } ...` 改为 `import { SettingsShell } from "@renderer/settings/SettingsShell";`，JSX 里 `<SettingsPanel />` → `<SettingsShell />`。删除 `src/renderer/settings/SettingsPanel.tsx`。

Run: `git rm src/renderer/settings/SettingsPanel.tsx`

- [ ] **Step 3: 验证**

Run: `pnpm typecheck` → 0 errors（确认没有别处仍 import SettingsPanel：`grep -rn "SettingsPanel" src/`，应为空）。
Run: `pnpm lint` → 0 errors。
Run: `pnpm test` → 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/ModelsSettings.tsx src/renderer/App.tsx
git rm src/renderer/settings/SettingsPanel.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): wire two-column settings shell; remove legacy modal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: 集成验证 + ROADMAP

**Files:** Modify `docs/superpowers/ROADMAP.md`.

- [ ] **Step 1: 全量自动化验证**

Run: `pnpm typecheck && pnpm lint && pnpm test` → 全绿。
Run: `pnpm test:all` → root + epub-parser + virtual-docs 全绿。

- [ ] **Step 2: 手动 GUI smoke（人工）** — `pnpm start`（阻塞），逐项确认：

1. 首次/空库：providers 列表出现 OpenAI / Anthropic / Gemini 三默认（各带预填型号、无 key）。
2. 切设置面（左栏 模型/外观/阅读）；**底层 reader 不重载**（打开一本书→开设置→关→书原位）。
3. 给某 provider 填 key → 「拉取模型」→ 勾选 → 添加所选 → 保存；「对话模型」的 model 下拉出现新增模型。
4. 「对话模型」选 provider + model → 测试连接：成功显成功；故意填错 key → 显示 provider **真实报错**（不编造）。
5. baseURL 留空显默认端点占位符；openai-compatible 留空阻止保存。
6. 外观/阅读：颜色模式三档、自动摘要开关照常工作（从旧 modal 迁移无回归）。
7. 移除一个 provider → 列表更新；若它是 assistant 当前 provider，对话模型回落未选态。

- [ ] **Step 3: 更新 ROADMAP** — `docs/superpowers/ROADMAP.md`：
- RA5 行状态 `🟡` → `✅`（并把「多 provider 类型 🔴」备注更新为已完成）。
- backlog「provider `baseUrl` 设置」行 `🔴` → `✅`。
- 若顶部「下一目标候选」散文含 RA5，更新为已完成。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit --no-verify -m "$(cat <<'EOF'
docs(roadmap): mark RA5 multi-provider + baseUrl done

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: 收尾** — 用 superpowers:finishing-a-development-branch 收束 `feat/ra5-multi-provider`。

---

## 自审记录（spec 覆盖核对）

- §3.1 providers.models 列 → Task 1。✓
- §3.2 DEFAULT_BASE_URL / PROVIDER_TYPE_LABEL → Task 2。✓
- §3.3 ProviderDto.models / upsert.models / listModels 契约 → Task 2（契约）+ Task 3（DTO/仓储）。✓
- §3.4 DEFAULT_PROVIDERS + seedDefaultProviders（空表才播）+ initDb 接入 → Task 4。✓
- §4.1 仓储 toDto/upsert models → Task 3。✓
- §4.2 buildModelsRequest + adaptModelsResponse（Zod 边界、openai-compatible best-effort）→ Task 5；fetchProviderModels + 错误映射 → Task 6。✓
- §4.3 providers:list-models IPC（key 解析两场景）+ preload → Task 7（含 reveal 补漏）。✓
- §5.1 双栏外壳（settings-store.open 覆盖、Esc/✕、左栏分类）→ Task 10；activeCategory → Task 9。✓
- §5.2 对话模型选择器 / ProviderCard / ProviderForm / ModelEditor（拉取勾选+手输）→ Task 11/12；ModelsSettings 组合 → Task 13。✓
- §5.3/5.4 外观/阅读迁移 → Task 10。✓
- §5.5 shadcn select → Task 8。✓
- §7 测试：providers 契约/元数据（T2）、仓储 models（T3）、seed（T4）、buildRequest+adaptResponse+Zod（T5）、fetch+错误（T6）、UI 纯逻辑（T9）；GUI smoke（T14）。✓
- 类型一致性：`ProviderType`/`UpsertProviderInput`/`ProviderDto.models`/`ListModelsInput`/`ListModelsResult`/`ProviderFormState`/`DEFAULT_BASE_URL`/`PROVIDER_TYPE_LABEL`/`DEFAULT_PROVIDERS` 跨任务一致。✓
- 解析层 `resolveAssistantModel`/`model-factory`/`assistants.model` 零改动 — 计划无任务触及。✓
