# Marginalia MA3 · Provider 配置与密钥安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 main 侧实现 Provider 配置（CRUD + 密钥 safeStorage 加密 + 掩码预览 + 按需揭示 + **真打对话端点的测试连接**）与单个可编辑的默认 Assistant，全部 headless 可测。

**Architecture:** 沿用既有「纯业务函数 + 胶水层注入」模式。密钥加解密与连通性测试作为**端口（port 接口）**注入纯函数：真实实现（Electron `safeStorage` / AI SDK `generateText` 探测）放在 main 胶水层，单测注入 fake。「测试连接」用 AI SDK v6 `generateText` 对真实对话端点发一次**最小生成**（`maxOutputTokens: 1`），并抽出 `resolveLanguageModel`（provider 配置 + 模型名 → `LanguageModel`）作为 **MA4 `streamText` 也复用**的工厂。Provider/Assistant 仓库是纯函数（注入 `DB` + `Encryptor` + `ProviderTester`），可在 vitest Node 环境直接测。Zod schema 全部进 `src/shared/` 作单一事实源。

**Tech Stack:** Drizzle ORM + better-sqlite3、Electron `safeStorage`、Zod 4、Vercel AI SDK v6（`ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` + `@ai-sdk/google` + `@ai-sdk/openai-compatible`）、vitest。**新增依赖：** `@ai-sdk/openai`、`@ai-sdk/google`、`@ai-sdk/openai-compatible`（`ai` + `@ai-sdk/anthropic` 已装）。**无 schema 改动、无迁移**（`providers` / `assistants` 表在 MA1 已建并迁移）。

---

## 背景与约束（实施者必读）

- **包管理**：一律用 `pnpm` / `pnpx`（**不要** `npx`/`bunx`）。
- **新依赖是纯 JS**（无原生模块），但 `pnpm add` 会触发安装；若之后某次跑测试出现 better-sqlite3 ABI 不匹配，先 `pnpm db:rebuild:node`。
- **better-sqlite3 ABI 双轨**：vitest 跑在 Node ABI。若此前跑过 `pnpm start`（Electron ABI），跑测试前先 `pnpm db:rebuild:node`。
- **prek 预提交 hook**：`git commit` 会触发 `lint:fix` + `format`，可能改写暂存文件并以 "files were modified by this hook" 中止。遇到时 `git add` 被改文件，再执行**同一条** commit 命令即可（第二次通过）。
- **不要** `git -C <dir>`。
- **路径别名**：新文件全部落在 `@main`（`src/main`）/ `@shared`（`src/shared`）现有别名根下，**无需**改任何别名配置。
- **不动 schema / 不跑 `pnpm db:generate`**：`providers`、`assistants` 表已存在于 `src/main/db/schema.ts` 并已迁移。
- **不动 `src/preload.ts`**：与 MA2 一致，`window.api` 的 providers/assistant 方法暴露**延后到 UI/renderer 轨**统一接线（renderer 当前仍是模板桩，提前暴露是无人调用的死代码）。MA3 只注册 main 侧 handlers。
- 现有约定参考：`src/main/library/repository.ts`（纯函数 + 注入 DB + `.transaction` + `.returning().get()`）、`src/main/ipc/library-handlers.ts`（`handle()` 胶水）、`src/main/library/repository.test.ts`（`createDb(":memory:")` + `runMigrations` 范式）。

## 文件结构

| 文件                                         | 职责                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/providers.ts`                    | Provider Zod schema（类型枚举、upsert 入参、id 入参、**test 入参 `{id, model}`**、测试结果、揭示结果）+ `z.infer` 派生类型 + `ProviderDto` |
| `src/shared/assistant.ts`                    | Assistant 更新入参 Zod schema + `AssistantDto`                                                                                             |
| `src/shared/ipc.ts`                          | （改）新增 7 个 IPC 通道名常量                                                                                                             |
| `src/main/secrets/encryptor.ts`              | `Encryptor` 端口接口（纯接口，不引用 Electron）                                                                                            |
| `src/main/secrets/safe-storage-encryptor.ts` | `Encryptor` 的 Electron `safeStorage` 实现（胶水）                                                                                         |
| `src/main/secrets/tester.ts`                 | `ProviderTester` 端口 + `ProviderTestParams`（含 `model`）                                                                                 |
| `src/main/secrets/ai-sdk-tester.ts`          | `ProviderTester` 的 AI SDK 实现：`generateText` 最小探测 + `mapTestError`（probe 可注入）                                                  |
| `src/main/ai/model-factory.ts`               | `resolveLanguageModel`：(provider 配置 + 模型名) → AI SDK `LanguageModel`。MA3 测连接 + MA4 对话共用                                       |
| `src/main/providers/mask.ts`                 | `maskKey` 纯函数（明文 → `sk-…1234`）                                                                                                      |
| `src/main/providers/repository.ts`           | Provider 仓库纯函数：list/get/upsert/remove/reveal/test（注入 `DB`+`Encryptor`+`ProviderTester`）                                          |
| `src/main/providers/assistant.ts`            | 默认 Assistant 纯函数：get-or-seed / update（注入 `DB`）                                                                                   |
| `src/main/ipc/settings-handlers.ts`          | 胶水层：`registerSettingsHandlers()`，注入 `getDb()` / `safeStorageEncryptor` / `aiSdkTester`                                              |
| `src/main.ts`                                | （改）`app.ready` 中调用 `registerSettingsHandlers()`                                                                                      |

测试：`src/shared/providers.test.ts`、`src/main/providers/mask.test.ts`、`src/main/ai/model-factory.test.ts`、`src/main/secrets/ai-sdk-tester.test.ts`、`src/main/providers/repository.test.ts`、`src/main/providers/assistant.test.ts`。

---

## Task 1: shared 契约（providers + assistant Zod schema + IPC 通道名）

**Files:**

- Create: `src/shared/providers.ts`
- Create: `src/shared/assistant.ts`
- Create: `src/shared/providers.test.ts`
- Modify: `src/shared/ipc.ts`

- [ ] **Step 1: 写失败测试** — `src/shared/providers.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { testProviderInput, upsertProviderInput } from "@shared/providers";

describe("upsertProviderInput", () => {
  it("accepts a minimal create (type only)", () => {
    expect(upsertProviderInput.safeParse({ type: "openai" }).success).toBe(true);
  });

  it("rejects an unknown provider type", () => {
    expect(upsertProviderInput.safeParse({ type: "cohere" }).success).toBe(false);
  });

  it("requires baseUrl for openai-compatible", () => {
    const r = upsertProviderInput.safeParse({ type: "openai-compatible" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("baseUrl"))).toBe(true);
  });

  it("accepts openai-compatible when baseUrl is provided", () => {
    expect(
      upsertProviderInput.safeParse({
        type: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-x",
      }).success,
    ).toBe(true);
  });
});

describe("testProviderInput", () => {
  it("requires both id and a non-empty model", () => {
    expect(testProviderInput.safeParse({ id: "p1", model: "gpt-4o-mini" }).success).toBe(true);
    expect(testProviderInput.safeParse({ id: "p1" }).success).toBe(false);
    expect(testProviderInput.safeParse({ id: "p1", model: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/shared/providers.test.ts`
Expected: FAIL（`@shared/providers` 不存在）

- [ ] **Step 3: 实现 `src/shared/providers.ts`**

```ts
import { z } from "zod";

export const providerType = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type ProviderType = z.infer<typeof providerType>;

/** 只含一个 provider id 的入参（reveal / remove 共用）。 */
export const providerIdInput = z.object({ id: z.string().min(1) });
export type ProviderIdInput = z.infer<typeof providerIdInput>;

/** 测试连接入参：provider id + 要测试的模型名（生成端点必须指定模型）。 */
export const testProviderInput = z.object({ id: z.string().min(1), model: z.string().min(1) });
export type TestProviderInput = z.infer<typeof testProviderInput>;

/**
 * 新建（无 id）或更新（带 id）一个 provider。
 * apiKey 三态语义：
 *  - 省略（undefined）→ 更新时保留既有密钥；新建时无密钥。
 *  - 提供非空字符串 → 加密后替换。
 * 不支持把 key 清空为 null（YAGNI；如需移除整条记录用 remove）。
 */
export const upsertProviderInput = z
  .object({
    id: z.string().min(1).optional(),
    type: providerType,
    label: z.string().nullish(),
    baseUrl: z.string().min(1).nullish(),
    apiKey: z.string().min(1).optional(),
  })
  .refine((v) => v.type !== "openai-compatible" || (v.baseUrl != null && v.baseUrl.length > 0), {
    message: "baseUrl is required for openai-compatible providers",
    path: ["baseUrl"],
  });
export type UpsertProviderInput = z.infer<typeof upsertProviderInput>;

/** 发往 renderer 的 provider 视图：绝不含明文 / 密文，只含掩码预览。 */
export interface ProviderDto {
  id: string;
  type: ProviderType;
  label: string | null;
  baseUrl: string | null;
  /** 掩码预览（如 "sk-…1234"）；无密钥或无法解密时为 null。 */
  keyMask: string | null;
  /** 是否存有密钥（密文存在）。 */
  hasKey: boolean;
  /** 存有密钥但本机无法解密时为 false（如跨机器迁移 / safeStorage 不可用）。 */
  keyDecryptable: boolean;
  createdAt: number;
}

/** reveal 返回的临时明文（仅用于 UI「👁 显示」）。 */
export const revealResult = z.object({ apiKey: z.string() });
export type RevealResult = z.infer<typeof revealResult>;

/** 测试连接结果（判别联合）。 */
export const testResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type TestResult = z.infer<typeof testResult>;
```

- [ ] **Step 4: 实现 `src/shared/assistant.ts`**

```ts
import { z } from "zod";

/** 更新默认 Assistant 的可编辑字段（仅传入的字段被更新；providerId 传 null 表示解绑）。 */
export const updateAssistantInput = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().nullish(),
  providerId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
});
export type UpdateAssistantInput = z.infer<typeof updateAssistantInput>;

export interface AssistantDto {
  id: string;
  name: string;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
}
```

- [ ] **Step 5: 修改 `src/shared/ipc.ts`，在 `IPC` 对象内（`contentChapterSummary` 行后）追加 7 行**

```ts
  providersList: "providers:list",
  providersUpsert: "providers:upsert",
  providersReveal: "providers:reveal",
  providersTest: "providers:test",
  providersRemove: "providers:remove",
  assistantGetDefault: "assistant:get-default",
  assistantUpdate: "assistant:update",
```

- [ ] **Step 6: 运行测试 + 类型检查，确认通过**

Run: `pnpm test src/shared/providers.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/shared/providers.ts src/shared/assistant.ts src/shared/providers.test.ts src/shared/ipc.ts
git commit -m "feat(ma3): add shared Zod contracts for providers and assistant"
```

（若 prek 改写文件而中止：重新 `git add` 上述文件，再跑一次同样的 commit 命令。）

---

## Task 2: 密钥加解密端口 + safeStorage 适配器 + 掩码

**Files:**

- Create: `src/main/secrets/encryptor.ts`
- Create: `src/main/secrets/safe-storage-encryptor.ts`
- Create: `src/main/providers/mask.ts`
- Create: `src/main/providers/mask.test.ts`

- [ ] **Step 1: 写失败测试** — `src/main/providers/mask.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { maskKey } from "@main/providers/mask";

describe("maskKey", () => {
  it("masks a typical key as prefix…last4", () => {
    expect(maskKey("sk-proj-ABCDEF1234")).toBe("sk-…1234");
  });
  it("fully masks keys of length <= 8 to avoid leaking", () => {
    expect(maskKey("short")).toBe("••••");
    expect(maskKey("12345678")).toBe("••••");
  });
  it("masks a 9-char key (prefix + last4)", () => {
    expect(maskKey("abcde1234")).toBe("abc…1234");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/main/providers/mask.test.ts`
Expected: FAIL（`@main/providers/mask` 不存在）

- [ ] **Step 3: 实现 `src/main/providers/mask.ts`**

```ts
/**
 * 把 API key 明文转为可安全展示的掩码预览，例如 "sk-…1234"。
 * - 长度 ≤ 8：整体打码，不泄露任何字符（"••••"）。
 * - 否则：前缀（前 3 字符）+ "…" + 末 4 字符。
 */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
}
```

- [ ] **Step 4: 实现 `src/main/secrets/encryptor.ts`（端口接口）**

```ts
/** 加解密端口（port）：纯接口，不引用 Electron，便于注入纯函数与在测试中替换为 fake。 */
export interface Encryptor {
  /** OS 钥匙串是否可用。不可用时拒绝存储密钥，绝不明文落库。 */
  isAvailable(): boolean;
  /** 明文 → 密文 buffer。 */
  encrypt(plaintext: string): Buffer;
  /** 密文 buffer → 明文。失败时抛出。 */
  decrypt(ciphertext: Buffer): string;
}
```

- [ ] **Step 5: 实现 `src/main/secrets/safe-storage-encryptor.ts`（Electron 适配器）**

```ts
import { safeStorage } from "electron";
import type { Encryptor } from "@main/secrets/encryptor";

/** 基于 Electron safeStorage（OS 钥匙串）的真实加解密实现。仅在 main 胶水层使用，不进单测。 */
export const safeStorageEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
};
```

- [ ] **Step 6: 运行测试 + 类型检查，确认通过**

Run: `pnpm test src/main/providers/mask.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/main/secrets/encryptor.ts src/main/secrets/safe-storage-encryptor.ts src/main/providers/mask.ts src/main/providers/mask.test.ts
git commit -m "feat(ma3): add encryptor port, safeStorage adapter, and key masking"
```

---

## Task 3: 安装 AI SDK provider 包 + 模型工厂（MA4 复用）

**Files:**

- Modify: `package.json`（经 `pnpm add` 自动）
- Create: `src/main/ai/model-factory.ts`
- Create: `src/main/ai/model-factory.test.ts`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add @ai-sdk/openai @ai-sdk/google @ai-sdk/openai-compatible`
Expected: 三个包写入 `dependencies`（版本应与既有 `@ai-sdk/anthropic@^3.x` 同主版本、兼容 `ai@^6`）。装完若后续测试报 better-sqlite3 ABI 错，跑 `pnpm db:rebuild:node`。

- [ ] **Step 2: 写失败测试** — `src/main/ai/model-factory.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveLanguageModel } from "@main/ai/model-factory";

describe("resolveLanguageModel", () => {
  it("builds an openai model carrying the given model id", () => {
    const m = resolveLanguageModel({
      type: "openai",
      baseUrl: null,
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
    expect(m.modelId).toBe("gpt-4o-mini");
  });
  it("builds an anthropic model", () => {
    const m = resolveLanguageModel({
      type: "anthropic",
      baseUrl: null,
      apiKey: "sk",
      model: "claude-haiku-4-5",
    });
    expect(m.modelId).toBe("claude-haiku-4-5");
  });
  it("builds a google model", () => {
    const m = resolveLanguageModel({
      type: "google",
      baseUrl: null,
      apiKey: "sk",
      model: "gemini-2.0-flash",
    });
    expect(m.modelId).toBe("gemini-2.0-flash");
  });
  it("builds an openai-compatible model when baseUrl is provided", () => {
    const m = resolveLanguageModel({
      type: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk",
      model: "llama-3.2",
    });
    expect(m.modelId).toBe("llama-3.2");
  });
  it("throws for openai-compatible without a baseUrl", () => {
    expect(() =>
      resolveLanguageModel({ type: "openai-compatible", baseUrl: null, apiKey: "sk", model: "x" }),
    ).toThrow(/baseUrl/i);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test src/main/ai/model-factory.test.ts`
Expected: FAIL（`@main/ai/model-factory` 不存在）

- [ ] **Step 4: 实现 `src/main/ai/model-factory.ts`**

> 注：构造 provider 模型实例是**纯本地操作、不发网络请求**（网络发生在 `generateText` 时），故本工厂可直接单测。`ChatModel` 类型由 openai 工厂返回值推导（四家结构同为 AI SDK `LanguageModelV2`），避免从 `@ai-sdk/provider` 直接 import。

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderType } from "@shared/providers";

/** AI SDK 语言模型实例类型（由 provider 工厂返回；四家结构一致，可喂 generateText/streamText）。 */
export type ChatModel = ReturnType<ReturnType<typeof createOpenAI>>;

export interface ResolveModelParams {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string;
  model: string;
}

/** 把 (provider 配置 + 模型名) 解析为 AI SDK 语言模型。MA3 测连接与 MA4 对话共用此工厂。 */
export function resolveLanguageModel(p: ResolveModelParams): ChatModel {
  const withBase = (base?: string | null) => (base ? { baseURL: base } : {});
  switch (p.type) {
    case "openai":
      return createOpenAI({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey, ...withBase(p.baseUrl) })(p.model);
    case "openai-compatible":
      if (!p.baseUrl) throw new Error("openai-compatible provider requires a baseUrl");
      return createOpenAICompatible({
        name: "openai-compatible",
        apiKey: p.apiKey,
        baseURL: p.baseUrl,
      })(p.model);
  }
}
```

- [ ] **Step 5: 运行测试 + 类型检查，确认通过**

Run: `pnpm test src/main/ai/model-factory.test.ts && pnpm typecheck`
Expected: PASS（5 例全过；tsc 无报错）

> 若 `openai-compatible` 分支因结构差异导致返回类型不匹配 `ChatModel`，对该分支返回值加 `as ChatModel`（四家底层均为 `LanguageModelV2`，运行期一致）。若 `.modelId` 取不到，确认 provider 工厂可调用形式 `createXxx(opts)(modelId)` 与已装版本一致。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/main/ai/model-factory.ts src/main/ai/model-factory.test.ts
git commit -m "feat(ma3): add AI SDK provider packages and language model factory"
```

---

## Task 4: 连通性测试端口 + AI SDK 适配器（真打对话端点）

**Files:**

- Create: `src/main/secrets/tester.ts`
- Create: `src/main/secrets/ai-sdk-tester.ts`
- Create: `src/main/secrets/ai-sdk-tester.test.ts`

- [ ] **Step 1: 实现 `src/main/secrets/tester.ts`（端口接口）**

```ts
import type { ProviderType, TestResult } from "@shared/providers";

export interface ProviderTestParams {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string;
  model: string;
}

/** Provider 连通性测试端口：真实实现走网络（generateText），单测注入 fake。 */
export interface ProviderTester {
  test(params: ProviderTestParams): Promise<TestResult>;
}
```

- [ ] **Step 2: 写失败测试** — `src/main/secrets/ai-sdk-tester.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createAiSdkTester, mapTestError, type GenerateProbe } from "@main/secrets/ai-sdk-tester";

describe("mapTestError", () => {
  it("401 → invalid key", () => {
    expect(mapTestError({ statusCode: 401 })).toEqual({
      ok: false,
      status: 401,
      message: "Invalid API key",
    });
  });
  it("404 → model/endpoint not found", () => {
    expect(mapTestError({ statusCode: 404 })).toEqual({
      ok: false,
      status: 404,
      message: "Model or endpoint not found",
    });
  });
  it("500 → generic http error", () => {
    expect(mapTestError({ statusCode: 500 })).toEqual({
      ok: false,
      status: 500,
      message: "Provider returned HTTP 500",
    });
  });
  it("non-http error → connection failed", () => {
    expect(mapTestError(new Error("ECONNREFUSED"))).toEqual({
      ok: false,
      message: "Connection failed: ECONNREFUSED",
    });
  });
});

describe("createAiSdkTester", () => {
  it("returns ok:true when the probe succeeds", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai",
      baseUrl: null,
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: true });
  });

  it("maps a probe rejection through mapTestError", async () => {
    const probe: GenerateProbe = async () => {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    };
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai",
      baseUrl: null,
      apiKey: "bad",
      model: "gpt-4o-mini",
    });
    expect(r).toEqual({ ok: false, status: 401, message: "Invalid API key" });
  });

  it("returns ok:false when the model cannot be resolved (openai-compatible without baseUrl)", async () => {
    const probe: GenerateProbe = async () => {};
    const tester = createAiSdkTester(probe);
    const r = await tester.test({
      type: "openai-compatible",
      baseUrl: null,
      apiKey: "sk",
      model: "x",
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test src/main/secrets/ai-sdk-tester.test.ts`
Expected: FAIL（`@main/secrets/ai-sdk-tester` 不存在）

- [ ] **Step 4: 实现 `src/main/secrets/ai-sdk-tester.ts`**

> `mapTestError` 用 duck-typing 读 `statusCode`（AI SDK 的 `APICallError` 暴露 `.statusCode`），既能正确映射 AI SDK 错误，又便于用普通对象单测，无需构造 `APICallError`。真实 probe 用 `generateText` 发一次 1-token 生成、`maxRetries: 0` 快速失败。

```ts
import { generateText } from "ai";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";
import type { ProviderTestParams, ProviderTester } from "@main/secrets/tester";
import type { TestResult } from "@shared/providers";

/** 对给定模型发一次最小生成；成功即返回，失败即抛出。可注入用于测试。 */
export type GenerateProbe = (model: ChatModel) => Promise<void>;

const realProbe: GenerateProbe = async (model) => {
  await generateText({ model, prompt: "ping", maxOutputTokens: 1, maxRetries: 0 });
};

/** 把异常映射为 TestResult（读 statusCode；AI SDK APICallError 即带此字段）。 */
export function mapTestError(err: unknown): TestResult {
  const status =
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : undefined;
  if (status === 401 || status === 403) return { ok: false, status, message: "Invalid API key" };
  if (status === 404) return { ok: false, status, message: "Model or endpoint not found" };
  if (status !== undefined)
    return { ok: false, status, message: `Provider returned HTTP ${status}` };
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, message: `Connection failed: ${message}` };
}

/** 基于 AI SDK generateText 的真实 ProviderTester。probe 可注入用于测试。 */
export function createAiSdkTester(probe: GenerateProbe = realProbe): ProviderTester {
  return {
    async test(params: ProviderTestParams): Promise<TestResult> {
      let model: ChatModel;
      try {
        model = resolveLanguageModel(params);
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      try {
        await probe(model);
        return { ok: true };
      } catch (err) {
        return mapTestError(err);
      }
    },
  };
}

/** 进程级单例（main 胶水层注入仓库）。 */
export const aiSdkTester: ProviderTester = createAiSdkTester();
```

- [ ] **Step 5: 运行测试 + 类型检查，确认通过**

Run: `pnpm test src/main/secrets/ai-sdk-tester.test.ts && pnpm typecheck`
Expected: PASS（mapTestError 4 例 + createAiSdkTester 3 例 全过）

- [ ] **Step 6: 提交**

```bash
git add src/main/secrets/tester.ts src/main/secrets/ai-sdk-tester.ts src/main/secrets/ai-sdk-tester.test.ts
git commit -m "feat(ma3): add provider tester port and AI SDK connectivity adapter"
```

---

## Task 5: Provider 仓库（CRUD + 掩码 + 揭示 + 测试编排）

**Files:**

- Create: `src/main/providers/repository.ts`
- Create: `src/main/providers/repository.test.ts`

- [ ] **Step 1: 写失败测试** — `src/main/providers/repository.test.ts`：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import type { ProviderTester } from "@main/secrets/tester";
import {
  getProviderRow,
  listProviders,
  removeProvider,
  revealProviderKey,
  testProvider,
  upsertProvider,
} from "@main/providers/repository";
import {
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  updateDefaultAssistant,
} from "@main/providers/assistant";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

// 可逆 fake：明文 utf8 ↔ buffer，足够验证存取与掩码。
const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: (c) => c.toString("utf8"),
};
const unavailableEncryptor: Encryptor = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
const brokenDecryptEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: () => {
    throw new Error("cannot decrypt");
  },
};
const okTester: ProviderTester = { test: async () => ({ ok: true }) };

describe("provider repository", () => {
  it("creates a provider with an encrypted key and exposes only a masked preview", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    expect(dto.type).toBe("openai");
    expect(dto.hasKey).toBe(true);
    expect(dto.keyDecryptable).toBe(true);
    expect(dto.keyMask).toBe("sk-…ghij");
    const row = getProviderRow(db, dto.id);
    expect(row?.apiKeyEncrypted).toBeInstanceOf(Buffer);
    expect(row?.apiKeyEncrypted?.toString("utf8")).toBe("sk-abcdefghij");
  });

  it("creates a provider without a key", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "anthropic" });
    expect(dto.hasKey).toBe(false);
    expect(dto.keyMask).toBeNull();
    expect(dto.keyDecryptable).toBe(false);
  });

  it("update without apiKey keeps the existing key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-original99" });
    const updated = upsertProvider(db, fakeEncryptor, {
      id: created.id,
      type: "openai",
      label: "Renamed",
    });
    expect(updated.label).toBe("Renamed");
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-original99");
  });

  it("update with apiKey replaces the key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-original99" });
    upsertProvider(db, fakeEncryptor, { id: created.id, type: "openai", apiKey: "sk-replaced77" });
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-replaced77");
  });

  it("lists all providers", () => {
    const db = freshDb();
    upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-aaaaaaaa11" });
    upsertProvider(db, fakeEncryptor, { type: "anthropic", apiKey: "sk-bbbbbbbb22" });
    expect(listProviders(db, fakeEncryptor)).toHaveLength(2);
  });

  it("reveal returns the plaintext key; throws when no key", () => {
    const db = freshDb();
    const withKey = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-secretkey1" });
    expect(revealProviderKey(db, fakeEncryptor, withKey.id)).toBe("sk-secretkey1");
    const noKey = upsertProvider(db, fakeEncryptor, { type: "openai" });
    expect(() => revealProviderKey(db, fakeEncryptor, noKey.id)).toThrow(/no API key/i);
  });

  it("refuses to store a key when secure storage is unavailable", () => {
    const db = freshDb();
    expect(() =>
      upsertProvider(db, unavailableEncryptor, { type: "openai", apiKey: "sk-whatever12" }),
    ).toThrow(/secure storage is unavailable/i);
  });

  it("marks keyDecryptable false (and keyMask null) when decryption fails", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    const listed = listProviders(db, brokenDecryptEncryptor).find((p) => p.id === created.id);
    expect(listed?.hasKey).toBe(true);
    expect(listed?.keyDecryptable).toBe(false);
    expect(listed?.keyMask).toBeNull();
  });

  it("removeProvider deletes it and clears assistant references", () => {
    const db = freshDb();
    const prov = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    getDefaultAssistant(db);
    updateDefaultAssistant(db, { providerId: prov.id });
    removeProvider(db, prov.id);
    expect(getProviderRow(db, prov.id)).toBeUndefined();
    expect(getDefaultAssistant(db).providerId).toBeNull();
    expect(getDefaultAssistant(db).name).toBe(DEFAULT_ASSISTANT_NAME);
  });

  describe("testProvider", () => {
    it("returns ok:false when the provider has no key", async () => {
      const db = freshDb();
      const noKey = upsertProvider(db, fakeEncryptor, { type: "openai" });
      const r = await testProvider(db, fakeEncryptor, okTester, noKey.id, "gpt-4o-mini");
      expect(r).toEqual({ ok: false, message: "No API key set for this provider" });
    });

    it("returns ok:false when the key cannot be decrypted", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
      const r = await testProvider(db, brokenDecryptEncryptor, okTester, p.id, "gpt-4o-mini");
      expect(r.ok).toBe(false);
    });

    it("delegates to the tester with the decrypted key + model when valid", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
      let seen: { apiKey: string; model: string } | undefined;
      const spyTester: ProviderTester = {
        test: async (params) => {
          seen = { apiKey: params.apiKey, model: params.model };
          return { ok: true };
        },
      };
      const r = await testProvider(db, fakeEncryptor, spyTester, p.id, "gpt-4o-mini");
      expect(r).toEqual({ ok: true });
      expect(seen).toEqual({ apiKey: "sk-abcdefghij", model: "gpt-4o-mini" });
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/main/providers/repository.test.ts`
Expected: FAIL（`@main/providers/repository` 与 `@main/providers/assistant` 不存在）

> 注：本测试同时 import `assistant.ts`（Task 6 实现）。先实现本任务的 `repository.ts`；整套测试在 Task 6 落地后统一跑全绿（见 Task 6 Step 4）。

- [ ] **Step 3: 实现 `src/main/providers/repository.ts`**

```ts
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";
import type { Encryptor } from "@main/secrets/encryptor";
import type { ProviderTester } from "@main/secrets/tester";
import { maskKey } from "@main/providers/mask";
import type { ProviderDto, TestResult, UpsertProviderInput } from "@shared/providers";

export type ProviderRow = typeof providers.$inferSelect;

/** 行 → DTO：在 main 内解密以产生掩码，明文绝不离开 main。解密失败则优雅降级。 */
function toDto(row: ProviderRow, encryptor: Encryptor): ProviderDto {
  const cipher = row.apiKeyEncrypted;
  let keyMask: string | null = null;
  let keyDecryptable = false;
  if (cipher != null) {
    try {
      keyMask = maskKey(encryptor.decrypt(cipher));
      keyDecryptable = true;
    } catch {
      keyDecryptable = false;
    }
  }
  return {
    id: row.id,
    type: row.type,
    label: row.label ?? null,
    baseUrl: row.baseUrl ?? null,
    keyMask,
    hasKey: cipher != null,
    keyDecryptable,
    createdAt: row.createdAt,
  };
}

export function getProviderRow(db: DB, id: string): ProviderRow | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

export function listProviders(db: DB, encryptor: Encryptor): ProviderDto[] {
  return db
    .select()
    .from(providers)
    .all()
    .map((r) => toDto(r, encryptor));
}

export function upsertProvider(
  db: DB,
  encryptor: Encryptor,
  input: UpsertProviderInput,
): ProviderDto {
  // 仅当传入新明文 key 时加密；省略 apiKey = 保留既有密钥。
  let encrypted: Buffer | undefined;
  if (input.apiKey !== undefined) {
    if (!encryptor.isAvailable()) {
      throw new Error("Cannot store API key: OS secure storage is unavailable");
    }
    encrypted = encryptor.encrypt(input.apiKey);
  }

  if (input.id) {
    const existing = getProviderRow(db, input.id);
    if (!existing) throw new Error(`provider ${input.id} not found`);
    db.update(providers)
      .set({
        type: input.type,
        label: input.label ?? null,
        baseUrl: input.baseUrl ?? null,
        ...(encrypted !== undefined ? { apiKeyEncrypted: encrypted } : {}),
      })
      .where(eq(providers.id, input.id))
      .run();
    const row = getProviderRow(db, input.id);
    if (!row) throw new Error("upsertProvider: row missing after update");
    return toDto(row, encryptor);
  }

  const inserted = db
    .insert(providers)
    .values({
      type: input.type,
      label: input.label ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted: encrypted ?? null,
    })
    .returning()
    .get();
  return toDto(inserted, encryptor);
}

export function removeProvider(db: DB, id: string): void {
  db.transaction((tx) => {
    // 先解除默认 Assistant 对该 provider 的引用，避免外键约束失败。
    tx.update(assistants).set({ providerId: null }).where(eq(assistants.providerId, id)).run();
    tx.delete(providers).where(eq(providers.id, id)).run();
  });
}

export function revealProviderKey(db: DB, encryptor: Encryptor, id: string): string {
  const row = getProviderRow(db, id);
  if (!row) throw new Error(`provider ${id} not found`);
  if (row.apiKeyEncrypted == null) throw new Error(`provider ${id} has no API key`);
  return encryptor.decrypt(row.apiKeyEncrypted);
}

export async function testProvider(
  db: DB,
  encryptor: Encryptor,
  tester: ProviderTester,
  id: string,
  model: string,
): Promise<TestResult> {
  const row = getProviderRow(db, id);
  if (!row) throw new Error(`provider ${id} not found`);
  if (row.apiKeyEncrypted == null) {
    return { ok: false, message: "No API key set for this provider" };
  }
  let apiKey: string;
  try {
    apiKey = encryptor.decrypt(row.apiKeyEncrypted);
  } catch {
    return { ok: false, message: "Stored API key cannot be decrypted on this machine" };
  }
  return tester.test({ type: row.type, baseUrl: row.baseUrl ?? null, apiKey, model });
}
```

- [ ] **Step 4: 类型检查（assistant.ts 尚未实现，测试暂不全绿是预期）**

Run: `pnpm typecheck`
Expected: 仅 `@main/providers/assistant` 缺失相关报错（Task 6 解决）；`repository.ts` 自身无类型错误。

- [ ] **Step 5: 提交（与 Task 6 紧邻，跑全绿留到 Task 6）**

```bash
git add src/main/providers/repository.ts src/main/providers/repository.test.ts
git commit -m "feat(ma3): add provider repository (crud, mask, reveal, test)"
```

---

## Task 6: 默认 Assistant 仓库（get-or-seed + update）

**Files:**

- Create: `src/main/providers/assistant.ts`
- Create: `src/main/providers/assistant.test.ts`

- [ ] **Step 1: 写失败测试** — `src/main/providers/assistant.test.ts`：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
import {
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  updateDefaultAssistant,
} from "@main/providers/assistant";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("default assistant", () => {
  it("seeds a default assistant on first read", () => {
    const db = freshDb();
    const a = getDefaultAssistant(db);
    expect(a.name).toBe(DEFAULT_ASSISTANT_NAME);
    expect(a.systemPrompt).toBeTruthy();
    expect(a.id).toMatch(UUID_V7_RE);
  });

  it("returns the same row on subsequent reads (no duplicate seed)", () => {
    const db = freshDb();
    const a1 = getDefaultAssistant(db);
    const a2 = getDefaultAssistant(db);
    expect(a2.id).toBe(a1.id);
  });

  it("updates only the provided fields", () => {
    const db = freshDb();
    const before = getDefaultAssistant(db);
    const after = updateDefaultAssistant(db, { name: "My Reader", model: "gpt-4o" });
    expect(after.name).toBe("My Reader");
    expect(after.model).toBe("gpt-4o");
    expect(after.systemPrompt).toBe(before.systemPrompt);
  });

  it("rejects setting providerId to a non-existent provider", () => {
    const db = freshDb();
    getDefaultAssistant(db);
    expect(() => updateDefaultAssistant(db, { providerId: "nope" })).toThrow(/not found/i);
  });

  it("accepts a valid providerId and can unset it with null", () => {
    const db = freshDb();
    const prov = db.insert(providers).values({ type: "openai" }).returning().get();
    getDefaultAssistant(db);
    expect(updateDefaultAssistant(db, { providerId: prov.id }).providerId).toBe(prov.id);
    expect(updateDefaultAssistant(db, { providerId: null }).providerId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/main/providers/assistant.test.ts`
Expected: FAIL（`@main/providers/assistant` 不存在）

- [ ] **Step 3: 实现 `src/main/providers/assistant.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";
import type { AssistantDto, UpdateAssistantInput } from "@shared/assistant";

export const DEFAULT_ASSISTANT_NAME = "Default Assistant";
export const DEFAULT_SYSTEM_PROMPT =
  "You are a reading assistant embedded in an ePub reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.";

type AssistantRow = typeof assistants.$inferSelect;

function toDto(row: AssistantRow): AssistantDto {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt ?? null,
    providerId: row.providerId ?? null,
    model: row.model ?? null,
  };
}

/** 取默认 Assistant；库中无则懒创建一行（Phase 1 仅一个）。 */
export function getDefaultAssistant(db: DB): AssistantDto {
  const existing = db.select().from(assistants).orderBy(asc(assistants.createdAt)).limit(1).get();
  if (existing) return toDto(existing);
  const seeded = db
    .insert(assistants)
    .values({ name: DEFAULT_ASSISTANT_NAME, systemPrompt: DEFAULT_SYSTEM_PROMPT })
    .returning()
    .get();
  return toDto(seeded);
}

/** 更新默认 Assistant 的可编辑字段（仅传入的字段被更新）。 */
export function updateDefaultAssistant(db: DB, patch: UpdateAssistantInput): AssistantDto {
  const current = getDefaultAssistant(db);
  if (patch.providerId != null) {
    const exists = db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, patch.providerId))
      .get();
    if (!exists) throw new Error(`assistant update: provider ${patch.providerId} not found`);
  }
  db.update(assistants)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
    })
    .where(eq(assistants.id, current.id))
    .run();
  const row = db.select().from(assistants).where(eq(assistants.id, current.id)).get();
  if (!row) throw new Error("updateDefaultAssistant: row missing after update");
  return toDto(row);
}
```

- [ ] **Step 4: 运行 Task 5 + Task 6 全部测试 + 类型检查，确认通过**

Run: `pnpm test src/main/providers/ && pnpm typecheck`
Expected: PASS（repository.test.ts + assistant.test.ts 全部通过；tsc 无报错）

- [ ] **Step 5: 提交**

```bash
git add src/main/providers/assistant.ts src/main/providers/assistant.test.ts
git commit -m "feat(ma3): add editable default assistant repository"
```

---

## Task 7: IPC 胶水层 + main.ts 接线

**Files:**

- Create: `src/main/ipc/settings-handlers.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现 `src/main/ipc/settings-handlers.ts`**

```ts
import { z } from "zod";
import { IPC } from "@shared/ipc";
import {
  providerIdInput,
  testProviderInput,
  upsertProviderInput,
  type ProviderDto,
  type RevealResult,
  type TestResult,
  type UpsertProviderInput,
} from "@shared/providers";
import {
  updateAssistantInput,
  type AssistantDto,
  type UpdateAssistantInput,
} from "@shared/assistant";
import { getDb } from "@main/db/instance";
import {
  listProviders,
  removeProvider,
  revealProviderKey,
  testProvider,
  upsertProvider,
} from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { safeStorageEncryptor } from "@main/secrets/safe-storage-encryptor";
import { aiSdkTester } from "@main/secrets/ai-sdk-tester";
import { handle } from "@main/ipc/registry";

export function registerSettingsHandlers(): void {
  handle<void, ProviderDto[]>(IPC.providersList, z.void(), () =>
    listProviders(getDb(), safeStorageEncryptor),
  );

  handle<UpsertProviderInput, ProviderDto>(IPC.providersUpsert, upsertProviderInput, (input) =>
    upsertProvider(getDb(), safeStorageEncryptor, input),
  );

  handle<{ id: string }, RevealResult>(IPC.providersReveal, providerIdInput, (input) => ({
    apiKey: revealProviderKey(getDb(), safeStorageEncryptor, input.id),
  }));

  handle<{ id: string; model: string }, TestResult>(IPC.providersTest, testProviderInput, (input) =>
    testProvider(getDb(), safeStorageEncryptor, aiSdkTester, input.id, input.model),
  );

  handle<{ id: string }, void>(IPC.providersRemove, providerIdInput, (input) =>
    removeProvider(getDb(), input.id),
  );

  handle<void, AssistantDto>(IPC.assistantGetDefault, z.void(), () => getDefaultAssistant(getDb()));

  handle<UpdateAssistantInput, AssistantDto>(IPC.assistantUpdate, updateAssistantInput, (input) =>
    updateDefaultAssistant(getDb(), input),
  );
}
```

- [ ] **Step 2: 修改 `src/main.ts` —— import**（`registerLibraryHandlers` 那行后追加）

```ts
import { registerSettingsHandlers } from "@main/ipc/settings-handlers";
```

- [ ] **Step 3: 修改 `src/main.ts` —— 在 `app.ready` 注册**（把注册段改为）

```ts
registerAppHandlers();
registerLibraryHandlers();
registerSettingsHandlers();
createWindow();
```

- [ ] **Step 4: 类型检查 + Lint + 全量测试，确认全绿**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS（tsc / oxlint 无报错；app 侧全部测试 + 新增 MA3 测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/settings-handlers.ts src/main.ts
git commit -m "feat(ma3): wire provider and assistant IPC handlers"
```

---

## 验收清单（实施完成后整体核对）

- [ ] `pnpm test` 全绿（含新增：providers schema、mask、model-factory、ai-sdk-tester、provider repository、default assistant）。
- [ ] `pnpm typecheck` / `pnpm lint` 无报错。
- [ ] 明文 API key **绝不**落库（仓库测试已断言密文 buffer）、**绝不**进 renderer（仅 `reveal` 临时返回，按 spec §12）。
- [ ] `safeStorage` 不可用时拒绝存 key。
- [ ] 「测试连接」走真实对话端点（`generateText`），错误按 statusCode 分类（401/403=密钥无效、404=模型/端点不存在）。
- [ ] `resolveLanguageModel` 可被 MA4 `streamText` 复用（四家 + openai-compatible）。
- [ ] 默认 Assistant 懒 seed 幂等、可编辑、providerId 受 FK 友好校验。
- [ ] 无 schema/迁移改动（`pnpm db:generate` 未被运行）。
- [ ] `src/preload.ts` 未改动（providers/assistant 的 `window.api` 暴露延后到 UI 轨）。

## 设计决策摘要（供评审）

1. **密钥加解密用「端口 + 适配器」**：`Encryptor` 端口注入纯仓库，真实 `safeStorage` 适配器在胶水层 → 仓库 headless 可测。
2. **测试连接 = 真打对话端点**（`generateText` 1-token 最小生成，`maxRetries:0` 快速失败）：测的是真正会用到的生成能力而非 `/models` 列表；`ProviderTester` 端口隔离网络副作用，`probe` 可注入故 `mapTestError` 与编排均可单测。
3. **抽出 `resolveLanguageModel` 工厂**（`src/main/ai/`）：MA3 测连接与 MA4 `streamText` 共用同一套 provider→模型解析，零返工。
4. **`test` 入参 = `{id, model}`**（扩展 spec §15 的 `test(id)`）：生成端点必须指定模型，且 provider 配置无 model 字段，故由调用方（settings UI）传入要测的模型。
5. **upsert 的 apiKey 三态**：省略=保留 / 提供=替换；不支持清空为 null（YAGNI，移除整条用 `remove`）。
6. **`removeProvider` 纳入**（spec 草图未列，settings 实用必需）：删除前把 `assistants.providerId` 置 null 避免外键失败（无需改 schema）。
7. **掩码在 main 内解密生成**（`sk-…1234`）；解密失败优雅降级 `keyMask=null` + `keyDecryptable=false`。
8. **默认 Assistant 懒 seed**；单 main 进程 + better-sqlite3 同步，无并发竞态。
9. **不改 schema、不改 preload**（与 MA1/MA2 现状一致）。
