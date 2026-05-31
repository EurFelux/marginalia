# MA5 · 流式层（AI 编排 send + 工具 + 摘要）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 main 侧实现「核心阅读闭环」AI 编排的**流式执行层**——把默认 Assistant 解析为可调用模型、把 MA2 的 `content.ts` 包装成 AI SDK 工具、章节摘要懒生成、以及 `runSend` 编排（路由 → 落 user 消息 → 组装 prompt → `streamText`+tools agent 循环 → 完成落 assistant 消息），全部为注入端口的函数，用 AI SDK v6 `MockLanguageModelV3` 完整 headless 测试。

**Architecture:** 沿用「纯/可注入函数 + 端口」模式。新增 `src/main/ai/` 下 4 个模块（assistant-model 模型解析、tools 工具注册表、summary 摘要懒生成、send 编排），并给 MA4 的 `chips.ts` 加一个快照投影助手。`runSend` 复用 MA4 的 `routeConversation`/`assemblePrompt`/`dedupeParagraph`/`appendMessage`/`getLastParagraphContent`、MA3 的 `resolveLanguageModel`/`getProviderRow`/`Encryptor`、MA2 的 `content.ts`。模型经端口注入（生产用 `resolveAssistantModel`，测试注入 `MockLanguageModelV3`）。**流式 IPC 传输（`ai:send`/`ai:stream` 事件通道 + `useChat` 自定 transport）有意延后到 UI 轨**——`runSend` 返回 UI message stream + 路由元信息供未来 UI 轨 handler 订阅；本计划不增任何 IPC 通道、不改 `main.ts`/`preload.ts`。

**Tech Stack:** TypeScript 6（strict）、Vercel AI SDK v6（`ai@6.0.193`：`streamText`/`generateText`/`tool`/`stepCountIs`/`toUIMessageStream`，`ai/test` 的 `MockLanguageModelV3`/`simulateReadableStream`）、Drizzle ORM 1.0.0-rc.3 + better-sqlite3（`:memory:` 测试）、Zod 4、vitest 4。

---

## 设计判定（实现者必读）

来自 `docs/superpowers/specs/2026-05-31-marginalia-core-reading-loop-design.md`（下称「设计文档」§8/§9/§11/§12/§16），严格遵循：

1. **模型经端口注入（headless 可测的关键）**：`runSend` / `ensureChapterSummary` 不直接构造 provider 模型，而是接受 `resolveModel: () => ResolvedModel` 端口。生产实现 `resolveAssistantModel(db, encryptor)`（默认 Assistant → provider → 解密 key → `resolveLanguageModel`）；测试注入返回 `MockLanguageModelV3` 的 fake。`MockLanguageModelV3` 实现 `LanguageModelV3`，与 `ChatModel`（model-factory）结构兼容，可直接喂 `streamText`/`generateText`。

2. **未配置模型时不产生副作用（设计文档 §16）**：`runSend` **先**解析模型；`{ok:false}` 时立即返回错误，**不路由、不落库**（避免留下孤儿会话）。

3. **消息落库形态（复用 MA4 设计文档 §5/§9）**：user 消息 `parts` 只存用户输入纯文本，chips 快照（去重后、`Chip → {id,content,tokenCount}`）入 `metadata.contextChips`；assistant 消息在流**完成**时由 `toUIMessageStream` 的 `onFinish.responseMessage.parts` 落库（含 text + tool-\* parts）。**出错不落半截**：仅在 `onFinish` 且 `!isAborted` 时落 assistant。

4. **章节摘要懒生成（设计文档 §11）**：状态机 `pending → generating → ready|unavailable`，只从 `pending` 触发；`generating`/`ready`/`unavailable` 一律 no-op。摘要默认用 Assistant 的 provider/model（同 `resolveModel`）。`runSend` 中：本章摘要 `ready` 才注入当前轮 prompt；`pending` 则后台 `ensureSummary(...)`（不阻塞、不 await），future 轮自动带上。模型未配置（`resolveModel` 非 ok）时摘要保持 `pending`、留待配置后重试。

5. **工具全部在 main 执行（设计文档 §8）**：`getToc` / `readChapterText` / `getChapterSummary` 包装 MA2 `content.ts`，AI SDK v6 `tool({ description, inputSchema, execute })`，Zod 入参。`readChapterText` 需书字节 → 经注入的 `loadBytes(bookId)` 端口（生产 `readFile(books.path)`，测试注入 `makeFixtureEpub` 字节）。`streamText({ tools, stopWhen: stepCountIs(5) })` 跑多步 agent 循环。

6. **零 schema 改动**：复用既有 `chapters`(摘要字段) / `conversations` / `messages`。本里程碑不跑 `pnpm db:generate`。

**MA4 评审延后项在本里程碑兑现**：chip 快照投影 `toContextChips`（Task 3）；`getChapterSummary` 缺 title → `runSend` 用私有 `getChapterTitle` 补查（Task 5）。

**延后到 UI 轨**（本计划不含）：`ai:send`/`ai:stream` IPC 事件通道 + `useChat` 自定 transport + preload；`presetId` 模板预填（UI 侧）；生产 `SendDeps` 工厂（接 `readFile` loadBytes + `safeStorageEncryptor` + 真 `ensureSummary`）随 UI 轨 handler 落地。

**AI SDK v6 mock 形状提示**：下文测试里的 `MockLanguageModelV3` 的 `doStream`/`doGenerate` 分片形状依 `@ai-sdk/provider` 的 `LanguageModelV3StreamPart`/`LanguageModelV3Content`（`ai@6.0.193`）。若某字段名不符（测试会立即报错），查 `node_modules/@ai-sdk/provider/dist/index.d.ts` 的 `LanguageModelV3StreamPart`/`LanguageModelV3Content`/`LanguageModelV3Usage` 微调（如 `finishReason`/`usage` 字段）。流分片关键形状：`{type:"text-start",id}` / `{type:"text-delta",id,delta}` / `{type:"text-end",id}` / `{type:"tool-call",toolCallId,toolName,input:<json string>}` / `{type:"finish",finishReason,usage}`。

---

## 文件结构

| 文件                             | 职责                                                                                                                   | 任务 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/main/ai/assistant-model.ts` | `resolveAssistantModel(db, encryptor): ResolvedModel`（默认 Assistant → provider → 解密 → 模型）+ `ResolvedModel` 类型 | 1    |
| `src/main/ai/tools.ts`           | `createReadingTools({db,bookId,loadBytes})` 三只读工具 + `LoadBytes` 类型                                              | 2    |
| `src/main/ai/chips.ts`（改）     | 加 `toContextChips(chips)`：`Chip[] → metadata.contextChips` 快照                                                      | 3    |
| `src/main/ai/summary.ts`         | `ensureChapterSummary(deps, bookId, chapterId)` 状态机 + `generateText`                                                | 4    |
| `src/main/ai/send.ts`            | `runSend(deps, input): SendResult` 编排 + streamText agent 循环 + 落库                                                 | 5    |

每个 `*.ts` 配套 `*.test.ts`（`chips.ts` 复用既有 `chips.test.ts`）。

---

## Task 1: assistant-model.ts —— 默认 Assistant 模型解析

**Files:**

- Create: `src/main/ai/assistant-model.ts`
- Test: `src/main/ai/assistant-model.test.ts`

`resolveAssistantModel` 把默认 Assistant 的 provider+model+解密 key 解析为可调用模型；任一前置缺失返回 `{ok:false, reason}`（供 `runSend` 在发送前友好拦截，设计文档 §16）。复用 MA3 的 `getProviderRow`、`getDefaultAssistant`、`resolveLanguageModel`、`Encryptor`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/assistant-model.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import { upsertProvider } from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { resolveAssistantModel } from "@main/ai/assistant-model";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: (c) => c.toString("utf8"),
};
const brokenDecrypt: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: () => {
    throw new Error("nope");
  },
};

function configure(db: ReturnType<typeof freshDb>) {
  const provider = upsertProvider(db, fakeEncryptor, {
    type: "openai",
    apiKey: "sk-test",
  });
  updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
  return provider;
}

describe("resolveAssistantModel", () => {
  it("resolves a model when assistant has a provider, model, and decryptable key", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.modelId).toBe("gpt-4o-mini");
      expect(r.model).toBeDefined();
    }
  });

  it("fails when the assistant has no provider configured", () => {
    const db = freshDb();
    getDefaultAssistant(db); // seed default assistant (no provider/model)
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false });
  });

  it("fails when the assistant has a provider but no model", () => {
    const db = freshDb();
    const provider = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk" });
    updateDefaultAssistant(db, { providerId: provider.id });
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false });
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, fakeEncryptor, { type: "openai" });
    updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false });
  });

  it("fails when the stored key cannot be decrypted on this machine", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db, brokenDecrypt);
    expect(r).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/assistant-model'`。

- [ ] **Step 3: 实现 `src/main/ai/assistant-model.ts`**

```ts
// src/main/ai/assistant-model.ts
import type { DB } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import { getDefaultAssistant } from "@main/providers/assistant";
import { getProviderRow } from "@main/providers/repository";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";

export type ResolvedModel =
  | { ok: true; model: ChatModel; modelId: string }
  | { ok: false; reason: string };

/** 把默认 Assistant 解析为可调用模型；任一前置缺失返回结构化错误（供发送前友好拦截）。 */
export function resolveAssistantModel(db: DB, encryptor: Encryptor): ResolvedModel {
  const assistant = getDefaultAssistant(db);
  if (!assistant.providerId) return { ok: false, reason: "assistant has no provider configured" };
  if (!assistant.model) return { ok: false, reason: "assistant has no model configured" };

  const provider = getProviderRow(db, assistant.providerId);
  if (!provider) return { ok: false, reason: "configured provider not found" };
  if (!provider.apiKeyEncrypted) return { ok: false, reason: "provider has no API key set" };
  if (!encryptor.isAvailable())
    return { ok: false, reason: "secure storage is unavailable on this machine" };

  let apiKey: string;
  try {
    apiKey = encryptor.decrypt(provider.apiKeyEncrypted);
  } catch {
    return { ok: false, reason: "stored API key cannot be decrypted on this machine" };
  }

  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey,
      model: assistant.model,
    });
    return { ok: true, model, modelId: assistant.model };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "failed to build model" };
  }
}
```

> 注：`getProviderRow` 已由 `@main/providers/repository` 导出（MA3）；`getDefaultAssistant` 会惰性播种默认 Assistant（无 provider/model）。`provider.apiKeyEncrypted` 是 `Buffer | null`；`provider.baseUrl` 是 `string | null`，与 `resolveLanguageModel` 入参一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: PASS（5 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/assistant-model.ts src/main/ai/assistant-model.test.ts
git commit -m "feat(ma5): add default-assistant model resolver"
```

---

## Task 2: tools.ts —— 只读阅读工具注册表

**Files:**

- Create: `src/main/ai/tools.ts`
- Test: `src/main/ai/tools.test.ts`

把 MA2 `content.ts` 的 `getToc`/`getChapterSummary`/`readChapterText` 包装成 AI SDK v6 工具（设计文档 §8）。`readChapterText` 经注入 `loadBytes` 端口取书字节。测试用 `makeFixtureEpub` + `importBook` + `resolveChapterByHref` 播种（与 `content.test.ts` 同套路）。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/tools.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function setup() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const loadBytes: LoadBytes = async () => bytes;
  const tools = createReadingTools({ db, bookId: book.id, loadBytes });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  return { db, bytes, book, tools, ch1 };
}

// AI SDK tool.execute 需要第二个 ToolCallOptions 参数；测试里传最小 stub。
const opts = { toolCallId: "test", messages: [] } as never;

describe("createReadingTools", () => {
  it("getToc returns the book's table of contents", async () => {
    const { tools } = setup();
    expect(await tools.getToc.execute!({}, opts)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });

  it("readChapterText loads bytes via the port and returns verbatim text", async () => {
    const { tools, ch1 } = setup();
    const slice = await tools.readChapterText.execute!({ chapterId: ch1.id }, opts);
    expect(slice.text).toContain("Hello world.");
    expect(slice.hasMore).toBe(false);
  });

  it("readChapterText forwards offset/maxChars for pagination", async () => {
    const { tools, ch1 } = setup();
    const slice = await tools.readChapterText.execute!(
      { chapterId: ch1.id, offset: 0, maxChars: 5 },
      opts,
    );
    expect(slice.text.length).toBe(5);
    expect(slice.hasMore).toBe(true);
    expect(slice.nextOffset).toBe(5);
  });

  it("getChapterSummary returns the cached summary state", async () => {
    const { tools, ch1 } = setup();
    expect(await tools.getChapterSummary.execute!({ chapterId: ch1.id }, opts)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("readChapterText inputSchema rejects an empty chapterId", () => {
    const { tools } = setup();
    expect(tools.readChapterText.inputSchema.safeParse({ chapterId: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/tools.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/tools'`。

- [ ] **Step 3: 实现 `src/main/ai/tools.ts`**

```ts
// src/main/ai/tools.ts
import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { getChapterSummary, getToc, readChapterText } from "@main/library/content";

/** 取某书原始字节（生产实现读 books.path；测试注入 fixture 字节）。 */
export type LoadBytes = (bookId: string) => Promise<Uint8Array>;

export interface ReadingToolsDeps {
  db: DB;
  bookId: string;
  loadBytes: LoadBytes;
}

/** 当前书的只读阅读工具集（设计文档 §8）；全部在 main 执行，喂 streamText({ tools })。 */
export function createReadingTools(deps: ReadingToolsDeps) {
  const { db, bookId, loadBytes } = deps;
  return {
    getToc: tool({
      description: "List the table of contents (chapters) of the current book.",
      inputSchema: z.object({}),
      execute: async () => getToc(db, bookId),
    }),
    getChapterSummary: tool({
      description: "Get the cached AI summary (and its status) of a chapter by its id.",
      inputSchema: z.object({ chapterId: z.string().min(1) }),
      execute: async ({ chapterId }) => getChapterSummary(db, bookId, chapterId),
    }),
    readChapterText: tool({
      description:
        "Read the verbatim text of a chapter, paginated by character offset; returns { text, hasMore, nextOffset }.",
      inputSchema: z.object({
        chapterId: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      execute: async ({ chapterId, offset, maxChars }) => {
        const bytes = await loadBytes(bookId);
        return readChapterText(db, bytes, bookId, chapterId, { offset, maxChars });
      },
    }),
  };
}
```

> 注：`tool().execute` 的运行时签名是 `(input, options)`；测试用 `as never` 传最小 `options` stub。若 TS 报 `execute` 可能为 `undefined`，用 `tools.x.execute!(...)`（如测试所示）。`getToc`/`getChapterSummary` 不需字节，仅 `readChapterText` 经 `loadBytes`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/tools.test.ts`
Expected: PASS（5 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/tools.ts src/main/ai/tools.test.ts
git commit -m "feat(ma5): add read-only reading tools (getToc, readChapterText, getChapterSummary)"
```

---

## Task 3: chips.ts（改）—— chip 快照投影

**Files:**

- Modify: `src/main/ai/chips.ts`
- Test: `src/main/ai/chips.test.ts`（追加）

加 `toContextChips`：把 live `Chip[]` 投影为持久化快照 `{id,content,tokenCount}[]`（落入 `metadata.contextChips`，兑现 MA4 评审延后项）。

- [ ] **Step 1: 在 `src/main/ai/chips.test.ts` 追加失败测试**

在文件末尾追加：

```ts
import { toContextChips } from "@main/ai/chips";

describe("toContextChips", () => {
  it("projects live chips to the persisted snapshot shape (drops labelKey/required/enabled)", () => {
    const chips = buildChips({ selection: "sel", paragraphCurrent: "para" });
    expect(toContextChips(chips)).toEqual([
      { id: "selection", content: "sel", tokenCount: chips[0].tokenCount },
      { id: "paragraph", content: "para", tokenCount: chips[1].tokenCount },
    ]);
  });
});
```

> 注：`buildChips` 已在本测试文件顶部 import；只需补 `toContextChips` 的 import（与现有 import 合并或新增一行）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/chips.test.ts`
Expected: FAIL —— `toContextChips` 未导出。

- [ ] **Step 3: 在 `src/main/ai/chips.ts` 末尾追加实现**

先在文件顶部 import 区加（若尚无）：

```ts
import type { MessageMetadata } from "@shared/types";
```

在文件末尾追加：

```ts
/** 把 live chip 投影为持久化快照（落入 UIMessage.metadata.contextChips）。 */
export function toContextChips(chips: Chip[]): NonNullable<MessageMetadata["contextChips"]> {
  return chips.map((c) => ({ id: c.id, content: c.content, tokenCount: c.tokenCount }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/chips.test.ts`
Expected: PASS（既有 6 + 新 1 = 7 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/chips.ts src/main/ai/chips.test.ts
git commit -m "feat(ma5): add chip snapshot projection (toContextChips)"
```

---

## Task 4: summary.ts —— 章节摘要懒生成

**Files:**

- Create: `src/main/ai/summary.ts`
- Test: `src/main/ai/summary.test.ts`

`ensureChapterSummary`（设计文档 §11）：仅从 `pending` 触发；置 `generating` → 抽章节正文 → `generateText` 摘要 → 存 `summary` + `ready`；失败 → `unavailable`；模型未配置 → 保持 `pending`。模块级 `inFlight` Set 防并发重复生成。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/summary.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import { ensureChapterSummary, type SummaryDeps } from "@main/ai/summary";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// 生成模型 mock：doGenerate 返回固定文本。若字段名报错，查 @ai-sdk/provider 的 LanguageModelV3Content/Usage 微调。
function genModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

function setup(model: ResolvedModel) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SummaryDeps = { db, loadBytes, resolveModel: () => model };
  return { db, book, ch1, deps };
}

function statusOf(db: ReturnType<typeof createDb>, chapterId: string) {
  return db.select().from(chapters).where(eq(chapters.id, chapterId)).get()!;
}

describe("ensureChapterSummary", () => {
  it("generates and stores the summary when the chapter is pending", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: genModel("A concise summary."),
      modelId: "mock",
    });
    await ensureChapterSummary(deps, book.id, ch1.id);
    const row = statusOf(db, ch1.id);
    expect(row.summaryStatus).toBe("ready");
    expect(row.summary).toBe("A concise summary.");
  });

  it("is a no-op when the chapter is not pending (already ready)", async () => {
    const { db, book, ch1, deps } = setup({ ok: true, model: genModel("X"), modelId: "mock" });
    db.update(chapters)
      .set({ summaryStatus: "ready", summary: "cached" })
      .where(eq(chapters.id, ch1.id))
      .run();
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summary).toBe("cached"); // unchanged
  });

  it("marks the chapter unavailable when generation throws", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summaryStatus).toBe("unavailable");
  });

  it("leaves the chapter pending when no model is configured", async () => {
    const { db, book, ch1, deps } = setup({ ok: false, reason: "not configured" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(statusOf(db, ch1.id).summaryStatus).toBe("pending");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/summary.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/summary'`。

- [ ] **Step 3: 实现 `src/main/ai/summary.ts`**

```ts
// src/main/ai/summary.ts
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { readChapterText } from "@main/library/content";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";

export const SUMMARY_SYSTEM =
  "You summarize a single book chapter for a reading assistant. Produce a concise, faithful summary (a few sentences) capturing the chapter's key events, ideas, and terms. Output only the summary, no preamble.";

const SUMMARY_INPUT_MAX_CHARS = 12_000; // 截断喂模型的章节正文，避免爆上下文

export interface SummaryDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
}

// 进程内并发去重：同一章节正在生成时，后续调用直接跳过。
const inFlight = new Set<string>();

/** 懒生成某章摘要（设计文档 §11）。仅从 pending 触发；非阻塞调用方 fire-and-forget。 */
export async function ensureChapterSummary(
  deps: SummaryDeps,
  bookId: string,
  chapterId: string,
): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;

  const row = db
    .select({ status: chapters.summaryStatus })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row || row.status !== "pending") return; // 仅从 pending 生成
  if (inFlight.has(chapterId)) return; // 并发去重

  const resolved = resolveModel();
  if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

  inFlight.add(chapterId);
  db.update(chapters).set({ summaryStatus: "generating" }).where(eq(chapters.id, chapterId)).run();
  try {
    const bytes = await loadBytes(bookId);
    const slice = readChapterText(db, bytes, bookId, chapterId, {
      maxChars: SUMMARY_INPUT_MAX_CHARS,
    });
    const { text } = await generateText({
      model: resolved.model,
      system: SUMMARY_SYSTEM,
      prompt: slice.text,
      maxOutputTokens: 512,
      maxRetries: 1,
    });
    db.update(chapters)
      .set({ summary: text, summaryStatus: "ready" })
      .where(eq(chapters.id, chapterId))
      .run();
  } catch (err) {
    console.warn(`[summary] chapter ${chapterId} generation failed:`, err);
    db.update(chapters)
      .set({ summaryStatus: "unavailable" })
      .where(eq(chapters.id, chapterId))
      .run();
  } finally {
    inFlight.delete(chapterId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/summary.test.ts`
Expected: PASS（4 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/summary.ts src/main/ai/summary.test.ts
git commit -m "feat(ma5): add lazy chapter-summary generation"
```

---

## Task 5: send.ts —— AI 发送编排 + agent 循环

**Files:**

- Create: `src/main/ai/send.ts`
- Test: `src/main/ai/send.test.ts`

`runSend`（设计文档 §9）：先解析模型（未配置即返回错误、不副作用）→ 路由会话 → 段落去重 → 取历史 → 落 user 消息（chips 快照）→ 注入/后台触发章节摘要 → 组装 prompt → `streamText`+tools+`stepCountIs` agent 循环 → 完成时落 assistant 消息（出错不落半截）。复用 MA4 的 `routeConversation`/`assemblePrompt`/`dedupeParagraph`/`appendMessage`/`getLastParagraphContent`/`listMessages`/`getChapterSummary` + Task 1-4 的 `ResolvedModel`/`createReadingTools`/`toContextChips`/`ensureChapterSummary` 端口。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/send.test.ts
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { listConversationsByBook } from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { buildChips } from "@main/ai/chips";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import { runSend, type SendDeps, type SendInput } from "@main/ai/send";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// 纯文本流 mock。若 finish/usage 字段名报错，查 @ai-sdk/provider 的 LanguageModelV3StreamPart/Usage。
function textStreamModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
}

// 两步 agent mock：第1步发 getToc 工具调用，第2步发文本。
function tocThenTextModel(text: string) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "c1", toolName: "getToc", input: "{}" },
              {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      };
    },
  });
}

function setup(model: ResolvedModel) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  const loadBytes: LoadBytes = async () => bytes;
  const ensureSummary = vi.fn();
  const deps: SendDeps = { db, loadBytes, resolveModel: () => model, ensureSummary };
  return { db, book, ch1, deps, ensureSummary };
}

function input(bookId: string, chapterId: string, over: Partial<SendInput> = {}): SendInput {
  return {
    bookId,
    currentChapterId: chapterId,
    activeConversationId: null,
    chips: buildChips({ selection: "the cat", paragraphCurrent: "the cat sat on the mat" }),
    userText: "what does this mean?",
    ...over,
  };
}

describe("runSend", () => {
  it("returns an error and creates nothing when no model is configured", () => {
    const { db, book, ch1, deps } = setup({ ok: false, reason: "not configured" });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(false);
    expect(listConversationsByBook(db, book.id)).toEqual([]);
  });

  it("persists the user message with a chip snapshot and the streamed assistant message", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: textStreamModel("It means hello."),
      modelId: "mock",
    });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const msgs = listMessages(db, r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const user = msgs[0];
    expect(user.parts).toEqual([{ type: "text", text: "what does this mean?" }]);
    expect(user.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection", "paragraph"]);
    expect(user.metadata?.model).toBe("mock");
    const assistantText = msgs[1].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(assistantText).toContain("It means hello.");
    expect(r.created).toBe(true);
  });

  it("runs the tool-calling agent loop and persists tool parts in the assistant message", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: tocThenTextModel("Done."),
      modelId: "mock",
    });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant")!;
    const partTypes = assistant.parts.map((p) => p.type);
    // 含 getToc 工具 part（AI SDK 把工具段记为 "tool-getToc" 或 "dynamic-tool"）+ 文本
    expect(partTypes.some((t) => t.startsWith("tool-") || t === "dynamic-tool")).toBe(true);
    expect(partTypes).toContain("text");
  });

  it("does not persist an assistant message when streaming errors", async () => {
    const failModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("stream boom");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const roles = listMessages(db, r.conversationId).map((m) => m.role);
    expect(roles).toEqual(["user"]); // 仅 user，无半截 assistant
  });

  it("omits the paragraph chip from the snapshot when it duplicates the conversation's last", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: textStreamModel("ok"),
      modelId: "mock",
    });
    // 第一次发送：建立会话并落入段落 "dup para"
    const first = runSend(
      deps,
      input(book.id, ch1.id, {
        chips: buildChips({ selection: "s1", paragraphCurrent: "dup para" }),
        userText: "q1",
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.finished;

    // 第二次发送：活动会话 = 同一会话、同章、相同段落 → 段落 chip 应被去重省略
    const second = runSend(
      deps,
      input(book.id, ch1.id, {
        activeConversationId: first.conversationId,
        chips: buildChips({ selection: "s2", paragraphCurrent: "dup para" }),
        userText: "q2",
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.finished;

    const userMsgs = listMessages(db, first.conversationId).filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection"]); // 段落已去重
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/send'`。

- [ ] **Step 3: 实现 `src/main/ai/send.ts`**

```ts
// src/main/ai/send.ts
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import { getChapterSummary } from "@main/library/content";
import { assemblePrompt } from "@main/ai/prompt";
import { dedupeParagraph, toContextChips } from "@main/ai/chips";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { routeConversation } from "@main/chat/conversations";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
import type { Chip } from "@shared/chat";

export interface SendInput {
  bookId: string;
  currentChapterId: string;
  activeConversationId: string | null;
  chips: Chip[];
  userText: string;
}

export interface SendDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /** 触发本章摘要懒生成（fire-and-forget；通常传 ensureChapterSummary 的偏函数）。 */
  ensureSummary: (bookId: string, chapterId: string) => void;
  /** agent 多步上限（默认 5）。 */
  stepLimit?: number;
}

export type SendResult =
  | {
      ok: true;
      conversationId: string;
      created: boolean;
      switchedFromActive: boolean;
      /** UI message stream，供 UI 轨 IPC 订阅推送。 */
      stream: AsyncIterable<unknown>;
      /** 落库（assistant 消息）完成后 resolve；出错也 resolve（不落半截）。 */
      finished: Promise<void>;
    }
  | { ok: false; reason: string };

function getChapterTitle(db: DB, bookId: string, chapterId: string): string | null {
  const row = db
    .select({ title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  return row?.title ?? null;
}

/** 选区 → AI 发送编排（设计文档 §9）。 */
export function runSend(deps: SendDeps, input: SendInput): SendResult {
  const { db, loadBytes, resolveModel, ensureSummary, stepLimit } = deps;

  // 1. 先解析模型——未配置即返回错误，不路由/不落库（避免孤儿会话，设计文档 §16）
  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // 2. 路由会话
  const route = routeConversation(db, {
    bookId: input.bookId,
    currentChapterId: input.currentChapterId,
    activeConversationId: input.activeConversationId,
  });
  const conversationId = route.conversationId;

  // 3. 段落去重（对照本会话上一次插入的段落）
  const deduped = dedupeParagraph(input.chips, getLastParagraphContent(db, conversationId));

  // 4. 取历史（在落入本轮 user 消息之前）
  const history = listMessages(db, conversationId);

  // 5. 落 user 消息（chips 快照入 metadata）
  appendMessage(db, {
    conversationId,
    role: "user",
    parts: [{ type: "text", text: input.userText }],
    metadata: { contextChips: toContextChips(deduped), model: resolved.modelId },
  });

  // 6. 章节摘要：ready 注入当前轮；pending 后台触发（不阻塞）
  const summary = getChapterSummary(db, input.bookId, input.currentChapterId);
  const chapter =
    summary.status === "ready" && summary.summary
      ? {
          title: getChapterTitle(db, input.bookId, input.currentChapterId),
          summary: summary.summary,
        }
      : null;
  if (summary.status === "pending") ensureSummary(input.bookId, input.currentChapterId);

  // 7. 组装 prompt（system 来自默认 Assistant）
  const assistant = getDefaultAssistant(db);
  const messages: ModelMessage[] = assemblePrompt({
    systemPrompt: assistant.systemPrompt,
    chapter,
    history,
    current: { chips: deduped, userText: input.userText },
  });

  // 8. streamText + tools + agent 循环
  const tools = createReadingTools({ db, bookId: input.bookId, loadBytes });
  const result = streamText({
    model: resolved.model,
    messages,
    tools,
    stopWhen: stepCountIs(stepLimit ?? 5),
  });

  // 9. 完成时落 assistant 消息；出错不落半截
  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });
  const stream = result.toUIMessageStream({
    onFinish: ({ responseMessage, isAborted }) => {
      if (!isAborted) {
        appendMessage(db, {
          conversationId,
          role: "assistant",
          parts: responseMessage.parts,
          metadata: { model: resolved.modelId },
        });
      }
    },
  });
  // 驱动流到完成（触发 onFinish）；出错吞掉但仍 resolve finished
  result
    .consumeStream()
    .catch(() => {})
    .finally(() => resolveDone());

  return {
    ok: true,
    conversationId,
    created: route.created,
    switchedFromActive: route.switchedFromActive,
    stream,
    finished,
  };
}
```

> 实现注意：
>
> - `resolveDone!` 用 definite-assignment（Promise executor 同步执行，赋值先于使用）。
> - `messages` 含 `assemblePrompt` 产出的 system 段作为首元素；`streamText({ messages })` 接受含 system 的 `ModelMessage[]`。若 SDK 拒绝 system 在 messages 中，改为把首个 system 段拆出走 `system:` 形参、其余走 `messages:`。
> - `onFinish.responseMessage.parts` 即新 assistant `UIMessage` 的 parts（含 text + `tool-*` parts）。`consumeStream()` 驱动 LLM 流跑完以触发 `onFinish`（参考 AI SDK 持久化最佳实践）。
> - `tool-call` 测试里断言 part 类型以 `tool-` 开头或 `dynamic-tool`——AI SDK v6 把具名工具段记为 `tool-<name>`（静态 tools）；若实际为别的判别，按报错调整断言。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS（5 测试）。若 `tool-call` 步骤或 `finish`/`usage` 分片字段报错，按「设计判定」末段提示对照 `@ai-sdk/provider` 的 `LanguageModelV3StreamPart` 微调 mock 分片，再跑。

- [ ] **Step 5: 全量校验 + 提交**

Run: `pnpm typecheck` → 无错误。
Run: `pnpm test` → 全量绿（既有 110 + 本里程碑新增）。
Run: `pnpm lint` → 无错误。

```bash
git add src/main/ai/send.ts src/main/ai/send.test.ts
git commit -m "feat(ma5): add AI send orchestration with streamText tool-calling agent loop"
```

> `git commit` 触发 prek（`lint:fix` + `format`）；若以「files were modified by this hook」中止，`git add` 被改文件后再跑相同 commit（第二次通过）。

---

## Self-Review

**1. Spec 覆盖（对照设计文档）：**

| 设计文档要求                                                                                                    | 落实任务                                                                                |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| §8 工具系统（getToc/readChapterText/getChapterSummary、Zod inputSchema、main 执行、大章节分页）                 | Task 2                                                                                  |
| §9 选区→AI 数据流（路由 → 落 user(chips 快照) → 组装 → streamText+tools 多步 → 完成落 assistant；出错不落半截） | Task 5                                                                                  |
| §10 prompt 组装（分层上下文、摘要降级、历史原样带）                                                             | 复用 MA4 `assemblePrompt`，Task 5 注入                                                  |
| §11 章节摘要懒生成（状态机、失败 unavailable、缓存复用）                                                        | Task 4                                                                                  |
| §12 provider/密钥（main 调用、解密 key）                                                                        | Task 1（`resolveAssistantModel` 解密）                                                  |
| §16 错误处理与降级（未配置友好拦截、流错不落半截、摘要失败禁用）                                                | Task 1（结构化错误）、Task 5（no-model 不副作用 + 错误不落半截）、Task 4（unavailable） |

**MA4→MA5 兑现**：chip 快照投影 `toContextChips`（Task 3）；`getChapterSummary` 缺 title → Task 5 `getChapterTitle` 补查。

**延后到 UI 轨（确认无遗漏）**：`ai:send`/`ai:stream` IPC 事件通道 + `useChat` transport + preload；`presetId`；生产 `SendDeps` 工厂。`runSend` 已返回 `stream` + 路由元信息，UI 轨 handler 订阅 `stream`、注入真实端口即可，无需改 MA5。

**2. 占位符扫描：** 无 TBD/TODO；每步含完整代码与可运行命令。AI SDK mock 分片形状已标注「报错即对照 `@ai-sdk/provider` 微调」的明确处置，非占位。

**3. 类型一致性核对：**

- `ResolvedModel`（Task 1）↔ `SummaryDeps.resolveModel`（Task 4）↔ `SendDeps.resolveModel`（Task 5）：同一类型，端口签名 `() => ResolvedModel`。
- `LoadBytes`（Task 2）↔ `SummaryDeps.loadBytes`/`SendDeps.loadBytes`：一致。
- `toContextChips`（Task 3）返回 `NonNullable<MessageMetadata["contextChips"]>` ↔ `appendMessage` 的 `metadata.contextChips`（Task 5 落库）：一致。
- `createReadingTools`（Task 2）↔ Task 5 `streamText({ tools })`：一致。
- `runSend` 复用的 MA4 函数签名（`routeConversation`/`assemblePrompt`/`dedupeParagraph`/`appendMessage`/`getLastParagraphContent`/`listMessages`）与 MA4 已合并实现一致。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-05-31-marginalia-ma5-streaming-orchestration.md`。两种执行方式：

1. **Subagent-Driven（推荐）** —— 每任务派独立 subagent，任务间两阶段评审（spec + 质量），快速迭代。
2. **Inline Execution** —— 本会话内分批执行（executing-plans），带检查点。

选哪个？
