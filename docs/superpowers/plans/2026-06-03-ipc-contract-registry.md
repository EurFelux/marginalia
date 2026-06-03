# IPC 契约注册表重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每条 IPC 通道的「通道名 + input schema + 类型」收敛到 `src/shared/ipc.ts` 的单一契约 map `C`，让 main handler 与 preload 两端引用同一份契约对象，消除四处人肉同步。

**Architecture:** 契约 map `C` 是单一源；`bind(C.x, fn)` 产出纯数据 `Binding`、`register(bindings)` 唯一碰 `ipcMain`（绕开 `ELECTRON_RUN_AS_NODE` 下 `ipcMain` 为 `undefined` 的测试约束）；preload 改为纯函数 `createApi(deps)` + `invoker(C.x)`，类型由契约派生、零手写标注。三个纯数据漂移测试兜底。renderer 的 `window.api` 形状与运行时语义不变。

**Tech Stack:** TypeScript 6（strict）、Zod 4、Electron 41、vitest 4（跑在 Electron 运行时）、oxlint/oxfmt。

**设计文档：** `docs/superpowers/specs/2026-06-03-ipc-contract-registry-design.md`

---

## 关键约定（每个任务都适用）

- **运行单个测试文件：** `pnpm test <path>`（如 `pnpm test src/shared/ipc.test.ts`）。
- **全量验证：** `pnpm typecheck && pnpm lint && pnpm test`。
- **提交：** pre-commit 钩子（prek）会跑 `lint:fix` + `format`，可能改暂存文件并以 "files were modified by this hook" 中止；遇到时 `git add` 被改文件后**重跑同一条 commit** 即过（见 CLAUDE.md）。
- **迁移任务是行为保持重构**：判定标准是 `pnpm typecheck` + 既有测试仍绿；务必删除迁移后变为未使用的 import（否则 oxlint 报错）。
- **共存策略**：Task 2 新增 `bind`/`register` 时**保留**旧 `handle`，使 handler 文件可逐个迁移且每次提交皆绿；Task 10 再删 `handle`。

---

## Task 1: 契约基础设施 + 契约 map `C` + 完整性测试

**Files:**

- Modify: `src/shared/ipc.ts`
- Test: `src/shared/ipc.test.ts`

本任务**纯新增**（保留现有 `IPC` 对象不动），故全程绿。

- [ ] **Step 1: 先写失败的契约完整性测试**

在 `src/shared/ipc.test.ts` 顶部 import 增加 `C`、`type Contract`，并追加一个 describe：

```ts
import { describe, expect, it } from "vitest";
import { appGetInfoResult, C, IPC, pingInput, pingResult, type Contract } from "@shared/ipc";

// …（保留文件中已有的 "ipc schemas" describe 原样不动）…

describe("ipc contract map C", () => {
  const entries = Object.entries(C) as [string, Contract][];

  it("every channel string is unique", () => {
    const channels = entries.map(([, c]) => c.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("every entry has a valid kind", () => {
    for (const [key, c] of entries) {
      expect(["invoke", "sync", "event"], `${key}`).toContain(c.kind);
    }
  });

  it("every entry carries an input Zod schema", () => {
    for (const [key, c] of entries) {
      expect(typeof c.input.safeParse, `${key}`).toBe("function");
    }
  });

  it("covers the known channels", () => {
    expect(C.libraryGet.channel).toBe("library:get");
    expect(C.aiChunk.kind).toBe("event");
    expect(C.preferencesGetAllSync.kind).toBe("sync");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/shared/ipc.test.ts`
Expected: FAIL —— `C` / `Contract` 尚未导出（编译或导入错误）。

- [ ] **Step 3: 在 `src/shared/ipc.ts` 实现契约基础设施 + `C`**

把 `src/shared/ipc.ts` 改为下述内容（**保留**文件末尾原有的 `pingInput`/`pingResult`/`appGetInfoResult` 段不动，仅在其上方加入契约层；**保留** `IPC` 对象不动，本任务不删）：

```ts
import { z } from "zod";
import type { TocNode } from "@shared/types";
import type {
  BookSummaryContentDto,
  BookSummaryDto,
  ChapterRefDto,
  ChapterSummaryDto,
  ChapterTextSlice,
} from "@shared/library";
import {
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
} from "@shared/library";
import type { ListModelsResult, ProviderDto, RevealResult, TestResult } from "@shared/providers";
import {
  listModelsInput,
  providerIdInput,
  testProviderInput,
  upsertProviderInput,
} from "@shared/providers";
import type { AssistantDto } from "@shared/assistant";
import { updateAssistantInput } from "@shared/assistant";
import type { AiStreamEvent, Chip, ConversationDto, MessageDto, SendAck } from "@shared/chat";
import {
  abortInput,
  buildChipsInput,
  conversationIdInput,
  createConversationInput,
  messagesByConversationInput,
  sendRequest,
} from "@shared/chat";
import type { AnnotationDto } from "@shared/annotations";
import {
  annotationIdInput,
  createAnnotationInput,
  updateAnnotationInput,
} from "@shared/annotations";
import type { PreferencesSnapshot } from "@shared/preferences";
import { setPreferenceInput } from "@shared/preferences";

/** output 幽灵类型载体：零运行时值，仅在类型层携带 O（main 不做 output 运行时校验，故无需 schema）。 */
declare const OUT: unique symbol;
export interface Out<O> {
  readonly [OUT]: O;
}
export const out = <O>(): Out<O> => ({}) as Out<O>;

export type IpcKind = "invoke" | "sync" | "event";

/** 单条 IPC 契约：通道名 + 种类 + input Zod schema + output 类型载体。 */
export interface Contract<S extends z.ZodType = z.ZodType, O = unknown> {
  channel: string;
  kind: IpcKind;
  input: S;
  output: Out<O>;
}

export type ContractMap = Record<string, Contract>;

export type InferIn<C> = C extends Contract<infer S, unknown> ? z.infer<S> : never;
export type InferOut<C> = C extends Contract<z.ZodType, infer O> ? O : never;

/** 定义一条契约，保留 S/O 的精确推导（供 bind/invoker 推类型）。 */
function def<S extends z.ZodType, O>(
  channel: string,
  kind: IpcKind,
  input: S,
  output: Out<O>,
): Contract<S, O> {
  return { channel, kind, input, output };
}

/**
 * IPC 契约单一真相源：新增/改通道只动这里。
 * input schema 复用各 domain 文件定义；output 为类型载体（不校验）。
 */
export const C = {
  // app / ping
  appGetInfo: def("app:get-info", "invoke", z.void(), out<AppGetInfoResult>()),
  appGetLocaleSync: def("app:get-locale-sync", "sync", z.void(), out<string>()),
  ping: def("ping", "invoke", pingInput, out<PingResult>()),

  // library
  libraryImport: def("library:import", "invoke", importBookInput, out<BookSummaryDto>()),
  libraryList: def("library:list", "invoke", z.void(), out<BookSummaryDto[]>()),
  libraryGet: def("library:get", "invoke", bookIdInput, out<BookSummaryDto | null>()),
  libraryPickEpub: def("library:pick-epub", "invoke", z.void(), out<string | null>()),
  libraryReadEpubBytes: def("library:read-epub-bytes", "invoke", bookIdInput, out<Uint8Array>()),

  // progress
  progressGet: def("progress:get", "invoke", bookIdInput, out<{ cfi: string } | null>()),
  progressSave: def("progress:save", "invoke", saveProgressInput, out<void>()),

  // content
  contentToc: def("content:toc", "invoke", bookIdInput, out<TocNode[]>()),
  contentChapters: def("content:chapters", "invoke", bookIdInput, out<ChapterRefDto[]>()),
  contentChapterText: def(
    "content:chapter-text",
    "invoke",
    readChapterTextInput,
    out<ChapterTextSlice>(),
  ),
  contentChapterSummary: def(
    "content:chapter-summary",
    "invoke",
    chapterRefInput,
    out<ChapterSummaryDto>(),
  ),
  contentGenerateChapterSummary: def(
    "content:generate-chapter-summary",
    "invoke",
    chapterRefInput,
    out<ChapterSummaryDto>(),
  ),
  contentBookSummary: def(
    "content:book-summary",
    "invoke",
    bookIdInput,
    out<BookSummaryContentDto>(),
  ),
  contentGenerateBookSummary: def(
    "content:generate-book-summary",
    "invoke",
    bookIdInput,
    out<BookSummaryContentDto>(),
  ),

  // annotations
  annotationsListByBook: def(
    "annotations:list-by-book",
    "invoke",
    bookIdInput,
    out<AnnotationDto[]>(),
  ),
  annotationsCreate: def(
    "annotations:create",
    "invoke",
    createAnnotationInput,
    out<AnnotationDto>(),
  ),
  annotationsUpdate: def(
    "annotations:update",
    "invoke",
    updateAnnotationInput,
    out<AnnotationDto>(),
  ),
  annotationsDelete: def("annotations:delete", "invoke", annotationIdInput, out<void>()),

  // settings: providers + assistant
  providersList: def("providers:list", "invoke", z.void(), out<ProviderDto[]>()),
  providersUpsert: def("providers:upsert", "invoke", upsertProviderInput, out<ProviderDto>()),
  providersReveal: def("providers:reveal", "invoke", providerIdInput, out<RevealResult>()),
  providersTest: def("providers:test", "invoke", testProviderInput, out<TestResult>()),
  providersRemove: def("providers:remove", "invoke", providerIdInput, out<void>()),
  providersListModels: def(
    "providers:list-models",
    "invoke",
    listModelsInput,
    out<ListModelsResult>(),
  ),
  assistantGetDefault: def("assistant:get-default", "invoke", z.void(), out<AssistantDto>()),
  assistantUpdate: def("assistant:update", "invoke", updateAssistantInput, out<AssistantDto>()),

  // chat（conversationsCreate / conversationsGet 为 main-only：有 handler、preload 不暴露）
  conversationsListByBook: def(
    "conversations:list-by-book",
    "invoke",
    bookIdInput,
    out<ConversationDto[]>(),
  ),
  conversationsCreate: def(
    "conversations:create",
    "invoke",
    createConversationInput,
    out<ConversationDto>(),
  ),
  conversationsGet: def(
    "conversations:get",
    "invoke",
    conversationIdInput,
    out<ConversationDto | null>(),
  ),
  messagesListByConversation: def(
    "messages:list-by-conversation",
    "invoke",
    messagesByConversationInput,
    out<MessageDto[]>(),
  ),

  // ai
  aiBuildChips: def("ai:build-chips", "invoke", buildChipsInput, out<Chip[]>()),
  aiSend: def("ai:send", "invoke", sendRequest, out<SendAck>()),
  aiAbort: def("ai:abort", "invoke", abortInput, out<void>()),
  aiChunk: def("ai:chunk", "event", z.void(), out<AiStreamEvent>()),

  // preferences
  preferencesGetAllSync: def(
    "preferences:get-all-sync",
    "sync",
    z.void(),
    out<PreferencesSnapshot>(),
  ),
  preferencesSet: def("preferences:set", "invoke", setPreferenceInput, out<void>()),
};

/** IPC 通道名（main 注册 / preload 调用 共用） */
export const IPC = {
  // …保留现有 IPC 对象全部内容不动（Task 12 才删）…
} as const;

/** ping —— 演示"带入参且经 Zod 校验"的往返 */
export const pingInput = z.object({ msg: z.string().min(1) });
export type PingInput = z.infer<typeof pingInput>;
export const pingResult = z.object({ echo: z.string() });
export type PingResult = z.infer<typeof pingResult>;

/** app:get-info —— 无入参，返回版本与书数 */
export const appGetInfoResult = z.object({
  version: z.string(),
  bookCount: z.number().int().nonnegative(),
});
export type AppGetInfoResult = z.infer<typeof appGetInfoResult>;
```

> 注意：`pingInput` 在 `C.ping` 中被引用，但 `pingInput` 的 `const` 声明在文件下方——因 `C` 是 `const` 对象、`def(...)` 在模块求值时执行，`pingInput` 须在 `C` **之前**声明。**实现时把 `pingInput`/`pingResult`/`appGetInfoResult`/`AppGetInfoResult` 这几段上移到 `C` 定义之前**（紧跟 import 之后），避免「used before declaration」。`IPC` 对象保持原内容、位置随意（Task 12 删）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/shared/ipc.test.ts && pnpm typecheck`
Expected: PASS（新 describe 全绿，既有 "ipc schemas" describe 仍绿，typecheck 无错）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipc.test.ts
git commit -m "feat(ipc): add contract map C + Contract/Out types (#8)"
```

---

## Task 2: registry 新增 `bind`/`register`（保留旧 `handle`）

**Files:**

- Modify: `src/main/ipc/registry.ts`

纯新增，旧 `handle` 保留，全程绿。

- [ ] **Step 1: 改写 `src/main/ipc/registry.ts`**

```ts
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";
import type { Contract } from "@shared/ipc";

/**
 * 注册一个经 Zod 校验的 invoke handler。
 * handler 第二参为 IpcMainInvokeEvent（流式通道需要 event.sender）；不需要的 handler 忽略即可。
 * @deprecated 迁移期保留；全部 handler 改用 bind/register 后由 Task 10 删除。
 */
export function handle<I, O>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I, event: IpcMainInvokeEvent) => O | Promise<O>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      const input = validateInput(channel, inputSchema, raw);
      return await handler(input, event);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      throw err;
    }
  });
}

/** 声明式绑定：契约 + 业务 fn，纯数据、不碰 Electron（供 headless 覆盖测试读取）。 */
export interface Binding {
  contract: Contract;
  fn: (input: never, event: IpcMainInvokeEvent) => unknown;
}

/** 把契约与业务 fn 绑成一条 Binding；input 类型由契约 input schema 推导，返回值被 output 类型约束。 */
export function bind<S extends z.ZodType, O>(
  contract: Contract<S, O>,
  fn: (input: z.infer<S>, event: IpcMainInvokeEvent) => O | Promise<O>,
): Binding {
  return { contract, fn: fn as Binding["fn"] };
}

/** 唯一碰 ipcMain 的地方：为每条 Binding 注册经 Zod 校验的 invoke handler。 */
export function register(bindings: Binding[]): void {
  for (const { contract, fn } of bindings) {
    ipcMain.handle(contract.channel, async (event, raw: unknown) => {
      try {
        const input = validateInput(contract.channel, contract.input, raw);
        return await (fn as (i: unknown, e: IpcMainInvokeEvent) => unknown)(input, event);
      } catch (err) {
        console.error(`[ipc] ${contract.channel} failed:`, err);
        throw err;
      }
    });
  }
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm test src/main/ipc/validate.test.ts`
Expected: PASS（既有测试绿；新函数无消费方但编译通过）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/registry.ts
git commit -m "feat(ipc): add bind/register primitives alongside handle (#8)"
```

---

## Task 3: 迁移 app-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/app-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/app-handlers.ts` 为完整新内容**

```ts
import { app, ipcMain } from "electron";
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-service";
import { bind, register, type Binding } from "@main/ipc/registry";

export const appBindings: Binding[] = [
  bind(C.ping, ping),
  bind(C.appGetInfo, () => getAppInfo(getDb(), app.getVersion())),
];

export function registerAppHandlers(): void {
  register(appBindings);

  // 同步通道：preload 首帧前取系统 locale（供 i18n init 决定默认语言）。
  // 故意绕开异步 register；app.getLocale() 在极少数情况下可能抛，整体兜底返回 "en"，绝不让 i18n init 崩。
  ipcMain.on(C.appGetLocaleSync.channel, (e) => {
    try {
      e.returnValue = app.getLocale();
    } catch {
      e.returnValue = "en"; // 安全回退：取系统 locale 失败时默认英文
    }
  });
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test src/main/app-service.test.ts`
Expected: PASS（无未使用 import；行为不变）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/app-handlers.ts
git commit -m "refactor(ipc): migrate app-handlers to bindings (#8)"
```

---

## Task 4: 迁移 library-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/library-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/library-handlers.ts` 为完整新内容**

```ts
import { readFile } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import type { BookSummaryDto } from "@shared/library";
import { getDb } from "@main/db/instance";
import { getBook, importBook, listBooks } from "@main/library/repository";
import { readBookBytes } from "@main/library/book-bytes";
import { getProgress, saveProgress } from "@main/library/progress";
import { getToc, listChapters, readChapterText } from "@main/library/content";
import {
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  getChapterSummaryView,
} from "@main/ai/summary";
import { makeSummaryDeps } from "@main/ai/send-deps";
import { bind, register, type Binding } from "@main/ipc/registry";

const toDto = (b: {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
}): BookSummaryDto => ({
  id: b.id,
  title: b.title,
  author: b.author,
  path: b.path,
});

export const libraryBindings: Binding[] = [
  bind(C.libraryImport, async (input) => {
    const buf = await readFile(input.filePath).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`Cannot read epub file at "${input.filePath}": ${err.code ?? err.message}`);
    });
    const bytes = new Uint8Array(buf);
    return toDto(importBook(getDb(), { bytes, filePath: input.filePath }));
  }),

  bind(C.libraryPickEpub, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  }),

  bind(C.libraryList, () => listBooks(getDb()).map(toDto)),

  bind(C.libraryGet, (input) => {
    const b = getBook(getDb(), input.bookId);
    return b ? toDto(b) : null;
  }),

  bind(C.libraryReadEpubBytes, (input) => readBookBytes(getDb(), input.bookId)),

  bind(C.progressGet, (input) => {
    const p = getProgress(getDb(), input.bookId);
    return p ? { cfi: p.cfi } : null;
  }),

  bind(C.progressSave, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId))
      throw new Error(`progress:save — book ${input.bookId} not found`);
    saveProgress(db, input.bookId, input.cfi);
  }),

  bind(C.contentToc, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return getToc(db, input.bookId);
  }),

  bind(C.contentChapters, (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    return listChapters(db, input.bookId);
  }),

  bind(C.contentChapterSummary, (input) =>
    getChapterSummaryView(getDb(), input.bookId, input.chapterId),
  ),

  // 触发本章摘要懒生成（开章自动 / pill 手动按钮）。fire-and-forget：ensureChapterSummary
  // 内部自含 reject 兜底；同步前缀会把状态派生为 generating，故返回当前派生状态即时反馈。
  bind(C.contentGenerateChapterSummary, (input) => {
    const db = getDb();
    void ensureChapterSummary(makeSummaryDeps(), input.bookId, input.chapterId).catch((err) =>
      console.warn("[content] generate chapter summary failed:", err),
    );
    return getChapterSummaryView(db, input.bookId, input.chapterId);
  }),

  bind(C.contentBookSummary, (input) => getBookSummaryView(getDb(), input.bookId)),

  // 触发全书摘要懒生成（书卡手动按钮）。fire-and-forget；同步前缀置 inFlight，故返回即为 generating。
  bind(C.contentGenerateBookSummary, (input) => {
    const db = getDb();
    // force=true：书卡「生成/重新生成」总是（重）生成，覆盖旧摘要。
    void ensureBookSummary(makeSummaryDeps(), input.bookId, true).catch((err) =>
      console.warn("[content] generate book summary failed:", err),
    );
    return getBookSummaryView(db, input.bookId);
  }),

  bind(C.contentChapterText, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`content: book ${input.bookId} not found`);
    const buf = await readFile(book.path).catch((err: NodeJS.ErrnoException) => {
      throw new Error(
        `Cannot read epub for book "${input.bookId}" at "${book.path}": ${err.code ?? err.message}. The file may have been moved or deleted.`,
      );
    });
    const bytes = new Uint8Array(buf);
    return readChapterText(db, bytes, input.bookId, input.chapterId, {
      offset: input.offset,
      maxChars: input.maxChars,
    });
  }),
];

export function registerLibraryHandlers(): void {
  register(libraryBindings);
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（无未使用 import：已移除 `z`、`IPC`、各 input schema、`TocNode` 等仅用于旧泛型的导入；保留 `BookSummaryDto` 供 `toDto`）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/library-handlers.ts
git commit -m "refactor(ipc): migrate library-handlers to bindings (#8)"
```

---

## Task 5: 迁移 settings-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/settings-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/settings-handlers.ts` 为完整新内容**

```ts
import { net } from "electron";
import { C } from "@shared/ipc";
import { t } from "@main/i18n";
import { fetchProviderModels, mapModelsError } from "@main/providers/provider-models";
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
import { bind, register, type Binding } from "@main/ipc/registry";

export const settingsBindings: Binding[] = [
  bind(C.providersList, () => listProviders(getDb(), safeStorageEncryptor)),

  bind(C.providersUpsert, (input) => upsertProvider(getDb(), safeStorageEncryptor, input)),

  bind(C.providersReveal, (input) => ({
    apiKey: revealProviderKey(getDb(), safeStorageEncryptor, input.id),
  })),

  bind(C.providersTest, (input) =>
    testProvider(getDb(), safeStorageEncryptor, aiSdkTester, input.id, input.model),
  ),

  bind(C.providersRemove, (input) => removeProvider(getDb(), input.id)),

  bind(C.providersListModels, async (input) => {
    let apiKey: string;
    try {
      apiKey = input.apiKey ?? revealProviderKey(getDb(), safeStorageEncryptor, input.id ?? "");
    } catch {
      return {
        ok: false,
        message: t("errors.noApiKeyAvailable", "该$t(terms.provider)无可用密钥"),
      };
    }
    try {
      const netFetch: typeof fetch = (url, init) => net.fetch(url as string, init);
      const models = await fetchProviderModels(
        { type: input.type, baseUrl: input.baseUrl ?? null, apiKey },
        netFetch,
      );
      return { ok: true, models };
    } catch (err) {
      return { ok: false, ...mapModelsError(err, undefined) };
    }
  }),

  bind(C.assistantGetDefault, () => getDefaultAssistant(getDb())),

  bind(C.assistantUpdate, (input) => updateDefaultAssistant(getDb(), input)),
];

export function registerSettingsHandlers(): void {
  register(settingsBindings);
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（移除了 `z`、`IPC`、各 input schema 与 result 类型导入；保留 `t`、`net` 等运行时实际用到的）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/settings-handlers.ts
git commit -m "refactor(ipc): migrate settings-handlers to bindings (#8)"
```

---

## Task 6: 迁移 chat-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/chat-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/chat-handlers.ts` 为完整新内容**

```ts
// src/main/ipc/chat-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { bind, register, type Binding } from "@main/ipc/registry";

export const chatBindings: Binding[] = [
  bind(C.conversationsListByBook, (input) => listConversationsByBook(getDb(), input.bookId)),
  bind(C.conversationsCreate, (input) => createConversation(getDb(), input)),
  bind(C.conversationsGet, (input) => getConversation(getDb(), input.id)),
  bind(C.messagesListByConversation, (input) => listMessages(getDb(), input.conversationId)),
  bind(C.aiBuildChips, buildChips),
];

export function registerChatHandlers(): void {
  register(chatBindings);
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（移除 `IPC`、`bookIdInput` 及各 input schema / DTO 类型导入）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/chat-handlers.ts
git commit -m "refactor(ipc): migrate chat-handlers to bindings (#8)"
```

---

## Task 7: 迁移 annotations-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/annotations-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/annotations-handlers.ts` 为完整新内容**

```ts
// src/main/ipc/annotations-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";
import { bind, register, type Binding } from "@main/ipc/registry";

export const annotationsBindings: Binding[] = [
  bind(C.annotationsListByBook, (input) => listAnnotationsByBook(getDb(), input.bookId)),
  bind(C.annotationsCreate, (input) => createAnnotation(getDb(), input)),
  bind(C.annotationsUpdate, (input) => updateAnnotation(getDb(), input)),
  bind(C.annotationsDelete, (input) => deleteAnnotation(getDb(), input.id)),
];

export function registerAnnotationHandlers(): void {
  register(annotationsBindings);
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/annotations-handlers.ts
git commit -m "refactor(ipc): migrate annotations-handlers to bindings (#8)"
```

---

## Task 8: 迁移 preferences-handlers 到 bindings

**Files:**

- Modify: `src/main/ipc/preferences-handlers.ts`

- [ ] **Step 1: 改写 `src/main/ipc/preferences-handlers.ts` 为完整新内容**

```ts
import { ipcMain } from "electron";
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAllPreferences, setPreference } from "@main/preferences/repository";
import { bind, register, type Binding } from "@main/ipc/registry";
import { setMainLanguage } from "@main/i18n";

export const preferencesBindings: Binding[] = [
  // 写：运行时变更落盘（异步 invoke，fire-and-forget）。
  bind(C.preferencesSet, (input) => {
    // 按 key 判别窄化，使 (key, value) 关联类型传给泛型 setPreference 时成立（input 已经 Zod 校验）。
    switch (input.key) {
      case "readerPrefs":
        return setPreference(getDb(), input.key, input.value);
      case "lastHighlightStyle":
        return setPreference(getDb(), input.key, input.value);
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
      case "colorMode":
        return setPreference(getDb(), input.key, input.value);
      case "language":
        setMainLanguage(input.value);
        return setPreference(getDb(), input.key, input.value);
    }
  }),
];

export function registerPreferenceHandlers(): void {
  register(preferencesBindings);

  // 读：同步 sendSync 通道——preload 在首帧前取整份快照（挂 .dark + hydrate）。
  // 故意绕开异步 register；getDb() 在 DB 未就绪时可能抛，整体兜底返回 {}，绝不让首帧读崩。
  ipcMain.on(C.preferencesGetAllSync.channel, (e) => {
    try {
      e.returnValue = getAllPreferences(getDb());
    } catch {
      e.returnValue = {};
    }
  });
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test src/shared/preferences.test.ts`
Expected: PASS（移除 `IPC`、`setPreferenceInput`、`SetPreferenceInput` 导入）。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/preferences-handlers.ts
git commit -m "refactor(ipc): migrate preferences-handlers to bindings (#8)"
```

---

## Task 9: 迁移 ai-handlers 到 bindings + 修测试引用

**Files:**

- Modify: `src/main/ipc/ai-handlers.ts`
- Modify: `src/main/ipc/ai-handlers.test.ts`

- [ ] **Step 1: 改写 `src/main/ipc/ai-handlers.ts` 为完整新内容**

```ts
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { C } from "@shared/ipc";
import type { AiStreamEvent } from "@shared/chat";
import { bind, register, type Binding } from "@main/ipc/registry";
import { runSend, type SendResult } from "@main/ai/send";
import { makeSendDeps } from "@main/ai/send-deps";

type StreamSender = Pick<WebContents, "send" | "isDestroyed">;

/** 把 runSend 的 UIMessageChunk 流逐块经 ai:chunk 推回渲染层；abort 视为正常收尾。 */
export async function pumpStream(
  sender: StreamSender,
  streamId: string,
  result: Extract<SendResult, { ok: true }>,
  signal: AbortSignal,
): Promise<void> {
  const emit = (ev: AiStreamEvent) => {
    if (!sender.isDestroyed()) sender.send(C.aiChunk.channel, ev);
  };
  try {
    for await (const chunk of result.stream) {
      if (signal.aborted) break;
      emit({ streamId, type: "chunk", chunk });
    }
    await result.finished;
    emit({ streamId, type: "finish" });
  } catch (err) {
    if (signal.aborted) emit({ streamId, type: "finish" });
    else
      emit({ streamId, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

const controllers = new Map<string, AbortController>();

export const aiBindings: Binding[] = [
  bind(C.aiSend, (req, event: IpcMainInvokeEvent) => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    controllers.set(streamId, controller);

    const result = runSend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      controllers.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      controllers.delete(streamId);
    });
    return {
      ok: true,
      conversationId: result.conversationId,
      created: result.created,
      switchedFromActive: result.switchedFromActive,
    };
  }),

  bind(C.aiAbort, ({ streamId }) => {
    controllers.get(streamId)?.abort();
  }),
];

export function registerAiHandlers(): void {
  register(aiBindings);
}
```

> 说明：`bind(C.aiSend, …)` 的 fn 第二参 `event: IpcMainInvokeEvent` 即原 `handle` 透传的 event，用于 `event.sender` 推流——`bind` 的 fn 签名第二参恒为 `IpcMainInvokeEvent`，无需特殊 kind。

- [ ] **Step 2: 修 `src/main/ipc/ai-handlers.test.ts` 的通道引用**

把 import 行与三处断言里的 `IPC.aiChunk` 改为 `C.aiChunk.channel`：

```ts
import { describe, expect, it, vi } from "vitest";
import { C } from "@shared/ipc";
import { pumpStream } from "@main/ipc/ai-handlers";
import type { SendResult } from "@main/ai/send";
```

并把文件内 3 处 `[IPC.aiChunk, …]` 全部替换为 `[C.aiChunk.channel, …]`（`emits chunk* then finish` 里 2 处数组元素 + `error`/`finish` 两个 `at(-1)` 断言里的元素，共 4 个字面位置）。可用编辑器全局替换：`IPC.aiChunk` → `C.aiChunk.channel`，再删除原 `import { IPC } from "@shared/ipc";`（已被上面的 `C` 导入取代）。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test src/main/ipc/ai-handlers.test.ts`
Expected: PASS（pumpStream 行为不变，断言用新 channel 字符串——值仍是 `"ai:chunk"`）。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/ai-handlers.ts src/main/ipc/ai-handlers.test.ts
git commit -m "refactor(ipc): migrate ai-handlers to bindings (#8)"
```

---

## Task 10: 删除旧 `handle` + 新增 bindings 覆盖测试

**Files:**

- Modify: `src/main/ipc/registry.ts`
- Test: `src/main/ipc/bindings-coverage.test.ts`

此刻所有 handler 已迁到 `bind`/`register`，旧 `handle` 无消费方。

- [ ] **Step 1: 先写 bindings 覆盖测试**

Create `src/main/ipc/bindings-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { C } from "@shared/ipc";
import { appBindings } from "@main/ipc/app-handlers";
import { libraryBindings } from "@main/ipc/library-handlers";
import { settingsBindings } from "@main/ipc/settings-handlers";
import { chatBindings } from "@main/ipc/chat-handlers";
import { annotationsBindings } from "@main/ipc/annotations-handlers";
import { preferencesBindings } from "@main/ipc/preferences-handlers";
import { aiBindings } from "@main/ipc/ai-handlers";

const allBindings = [
  ...appBindings,
  ...libraryBindings,
  ...settingsBindings,
  ...chatBindings,
  ...annotationsBindings,
  ...preferencesBindings,
  ...aiBindings,
];

describe("ipc bindings coverage", () => {
  const boundChannels = new Set(allBindings.map((b) => b.contract.channel));
  const invokeChannels = new Set(
    Object.values(C)
      .filter((c) => c.kind === "invoke")
      .map((c) => c.channel),
  );

  it("every invoke contract has exactly one binding (no missing, no extra, no dup)", () => {
    expect(allBindings.length).toBe(boundChannels.size); // 无重复 channel
    expect(boundChannels).toEqual(invokeChannels); // 双向相等：覆盖全部 invoke，且无 invoke 之外的 binding
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm test src/main/ipc/bindings-coverage.test.ts`
Expected: PASS（所有 invoke 通道恰有一条 binding；sync/event 不入 binding 故不计）。

> 若 FAIL 显示某 channel 缺失/多余，说明前面某个迁移任务漏接或错接，回去修对应 handler 文件。

- [ ] **Step 3: 删除 `src/main/ipc/registry.ts` 里的旧 `handle` 函数**

删掉整个 `export function handle<I, O>(…) { … }`（连同其上的 JSDoc 注释块）。文件仅保留顶部 import、`Binding`/`bind`/`register`。删后 `z` 仍被 `bind` 用（`z.ZodType`、`z.infer`），`IpcMainInvokeEvent`/`ipcMain`/`validateInput`/`Contract` 均仍用，无需动 import。

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS（`handle` 已无引用；全测试套件绿）。

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/registry.ts src/main/ipc/bindings-coverage.test.ts
git commit -m "refactor(ipc): drop legacy handle + add bindings coverage test (#8)"
```

---

## Task 11: preload → `createApi` + `invoker` + preload 覆盖测试

**Files:**

- Create: `src/preload-api.ts`
- Modify: `src/preload.ts`
- Test: `src/preload-api.test.ts`

- [ ] **Step 1: 创建 `src/preload-api.ts`**

```ts
import type { z } from "zod";
import { C, type Contract } from "@shared/ipc";
import type { AiStreamEvent } from "@shared/chat";
import type { PreferencesSnapshot } from "@shared/preferences";

/** 由注入的 invoke 生成类型化调用函数；类型从 contract 流出，零手写标注。__channel 供漂移测试走树收集。 */
export function invoker<S extends z.ZodType, O>(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  contract: Contract<S, O>,
): ((input: z.infer<S>) => Promise<O>) & { __channel: string } {
  const fn = (input: z.infer<S>) => invoke(contract.channel, input) as Promise<O>;
  return Object.assign(fn, { __channel: contract.channel });
}

/** createApi 的注入依赖：把所有 Electron 触点收敛到此，使 createApi 成为可 headless 测试的纯函数。 */
export interface PreloadDeps {
  invoke: (channel: string, input: unknown) => Promise<unknown>;
  /** 订阅某 channel；cb 收到 payload（已剥离 IpcRendererEvent）；返回退订函数。 */
  on: (channel: string, cb: (payload: unknown) => void) => () => void;
  getPathForFile: (file: File) => string;
  prefsSnapshot: PreferencesSnapshot;
  appLocale: string;
}

/** 构建 window.api（形状与重构前完全一致）。纯函数，依赖经 deps 注入。 */
export function createApi(d: PreloadDeps) {
  const inv = <S extends z.ZodType, O>(c: Contract<S, O>) => invoker(d.invoke, c);
  return {
    app: {
      getInfo: inv(C.appGetInfo),
      /** 系统 locale（启动同步快照，供 i18n 决定默认语言）。 */
      locale: d.appLocale,
    },
    ping: inv(C.ping),

    library: {
      import: inv(C.libraryImport),
      pickEpub: inv(C.libraryPickEpub),
      list: inv(C.libraryList),
      get: inv(C.libraryGet),
      readEpubBytes: inv(C.libraryReadEpubBytes),
      /** 由拖入的 File 取磁盘路径（Electron 41 已移除 File.path，须经 webUtils）。同步、纯渲染端、非 IPC。 */
      pathForFile: (file: File) => d.getPathForFile(file),
    },

    progress: {
      get: inv(C.progressGet),
      save: inv(C.progressSave),
    },

    content: {
      toc: inv(C.contentToc),
      chapters: inv(C.contentChapters),
      chapterText: inv(C.contentChapterText),
      chapterSummary: inv(C.contentChapterSummary),
      generateChapterSummary: inv(C.contentGenerateChapterSummary),
      bookSummary: inv(C.contentBookSummary),
      generateBookSummary: inv(C.contentGenerateBookSummary),
    },

    annotations: {
      listByBook: inv(C.annotationsListByBook),
      create: inv(C.annotationsCreate),
      update: inv(C.annotationsUpdate),
      delete: inv(C.annotationsDelete),
    },

    preferences: {
      // 读同步（boot 时已取一次缓存于 prefsSnapshot）；写仍异步 fire-and-forget——非对称是有意的。
      // 注意：返回的是**启动快照**，不反映运行时 set() 的写入（仅启动 hydrate / theme-store 初始化各调一次；
      // 运行时态由各 store 在内存中持有）。勿在运行时重复调用 getAll() 当「当前值」读。
      getAll: () => d.prefsSnapshot,
      set: inv(C.preferencesSet),
    },

    settings: {
      providers: {
        list: inv(C.providersList),
        upsert: inv(C.providersUpsert),
        reveal: inv(C.providersReveal),
        test: inv(C.providersTest),
        remove: inv(C.providersRemove),
        listModels: inv(C.providersListModels),
      },
      assistant: {
        getDefault: inv(C.assistantGetDefault),
        update: inv(C.assistantUpdate),
      },
    },

    chat: {
      conversations: {
        listByBook: inv(C.conversationsListByBook),
      },
      messages: {
        listByConversation: inv(C.messagesListByConversation),
      },
    },

    ai: {
      buildChips: inv(C.aiBuildChips),
      send: inv(C.aiSend),
      abort: inv(C.aiAbort),
      /** 订阅本 streamId 的增量；返回退订函数。 */
      onChunk: (streamId: string, cb: (ev: AiStreamEvent) => void): (() => void) =>
        d.on(C.aiChunk.channel, (payload) => {
          const ev = payload as AiStreamEvent;
          if (ev.streamId === streamId) cb(ev);
        }),
    },
  };
}

export type RendererApi = ReturnType<typeof createApi>;
```

- [ ] **Step 2: 改写 `src/preload.ts` 为薄装配层**

```ts
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { C } from "@shared/ipc";
import type { PreferencesSnapshot } from "@shared/preferences";
import { createApi } from "./preload-api";

// 首帧前同步读整份偏好快照（read 仅启动一次）：供渲染层同步初始化 theme-store（挂 .dark）+ hydrate。
// 注意：挂 .dark 的 DOM 操作放在 renderer 入口（src/renderer.tsx），不在此处——sandbox preload 模块求值时
// document.documentElement 尚为 null，在此 toggle 会抛错并令整个 preload（含 contextBridge 暴露）失败。
const prefsSnapshot = ipcRenderer.sendSync(C.preferencesGetAllSync.channel) as PreferencesSnapshot;
const appLocale = ipcRenderer.sendSync(C.appGetLocaleSync.channel) as string;

const api = createApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  prefsSnapshot,
  appLocale,
});

contextBridge.exposeInMainWorld("api", api);

export type { RendererApi } from "./preload-api";
```

> `src/renderer/global.d.ts` 的 `import type { RendererApi } from "../preload"` 因上面的重导出而**零改动**仍生效。

- [ ] **Step 3: 写 preload 覆盖测试**

Create `src/preload-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { C } from "@shared/ipc";
import { createApi } from "./preload-api";

/** 递归收集 api 对象树上所有带 __channel 标记的函数的通道名。 */
function collectChannels(node: unknown, acc: Set<string>): void {
  if (typeof node === "function") {
    const ch = (node as { __channel?: string }).__channel;
    if (ch) acc.add(ch);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectChannels(v, acc);
  }
}

describe("preload api coverage", () => {
  const api = createApi({
    invoke: vi.fn(() => Promise.resolve()),
    on: vi.fn(() => () => {}),
    getPathForFile: () => "",
    prefsSnapshot: {},
    appLocale: "en",
  });

  const bound = new Set<string>();
  collectChannels(api, bound);

  const invokeChannels = new Set(
    Object.values(C)
      .filter((c) => c.kind === "invoke")
      .map((c) => c.channel),
  );

  // 这两条是 main-only：有 handler、preload 故意不暴露（renderer 零引用）。
  const KNOWN_MAIN_ONLY = new Set(["conversations:create", "conversations:get"]);

  it("every bound channel is a real invoke contract", () => {
    for (const ch of bound) expect(invokeChannels.has(ch), ch).toBe(true);
  });

  it("preload exposes all invoke channels except the known main-only set", () => {
    const notBound = new Set([...invokeChannels].filter((ch) => !bound.has(ch)));
    expect(notBound).toEqual(KNOWN_MAIN_ONLY);
  });
});
```

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS。`preload-api.test.ts` 两条断言绿：所有绑定通道都是真 invoke 契约；未暴露的 invoke 通道恰好等于 `{conversations:create, conversations:get}`。

> 若 `every bound channel is a real invoke contract` FAIL：preload 里写了 `inv(C.x)` 但 `C.x` 不是 invoke（如误用了 sync/event 通道）。
> 若 `preload exposes all invoke channels…` FAIL：要么新通道忘了在 `createApi` 加 `inv(C.x)`（应加），要么有意 main-only（把它加进 `KNOWN_MAIN_ONLY`）。

- [ ] **Step 5: Commit**

```bash
git add src/preload-api.ts src/preload.ts src/preload-api.test.ts
git commit -m "refactor(ipc): preload via createApi + invoker, derived from C (#8)"
```

---

## Task 12: 删除 `IPC` 常量对象 + 修 ipc.test.ts

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipc.test.ts`

此刻 `IPC` 对象已无运行时消费方（handler/preload 全用 `C`），仅 `ipc.test.ts` 引用。`app-service.ts` 只导入类型（`AppGetInfoResult`/`PingInput`/`PingResult`），不受影响。

- [ ] **Step 1: 删除 `src/shared/ipc.ts` 中的 `IPC` 对象**

删掉整个 `export const IPC = { … } as const;` 块（及其上方注释 `/** IPC 通道名… */`）。保留 `C`、契约类型、`pingInput`/`pingResult`/`appGetInfoResult` 及其类型导出。

- [ ] **Step 2: 修 `src/shared/ipc.test.ts` 中对 `IPC` 的引用**

把 "ipc schemas" describe 里 import 的 `IPC` 去掉，并把两处通道断言改为读契约：

```ts
import { describe, expect, it } from "vitest";
import { appGetInfoResult, C, pingInput, pingResult, type Contract } from "@shared/ipc";

describe("ipc schemas", () => {
  it("exposes channel names", () => {
    expect(C.appGetInfo.channel).toBe("app:get-info");
    expect(C.ping.channel).toBe("ping");
  });

  it("ping input rejects non-string msg", () => {
    expect(pingInput.safeParse({ msg: 123 }).success).toBe(false);
    expect(pingInput.safeParse({ msg: "hi" }).success).toBe(true);
    expect(pingInput.safeParse({ msg: "" }).success).toBe(false);
  });

  it("ping result accepts an echo string", () => {
    expect(pingResult.safeParse({ echo: "hello" }).success).toBe(true);
  });

  it("app info result requires version + bookCount", () => {
    expect(appGetInfoResult.safeParse({ version: "1.0.0", bookCount: 0 }).success).toBe(true);
    expect(appGetInfoResult.safeParse({ version: "1.0.0" }).success).toBe(false);
  });
});

// …（保留 Task 1 新增的 "ipc contract map C" describe 不动）…
```

- [ ] **Step 3: 确认无残留 `IPC` 引用**

Run: `grep -rn "\\bIPC\\b" src --include="*.ts" --include="*.tsx"`
Expected: 无输出（或仅注释里出现）。若有代码引用，说明前序任务漏改，回去修。

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipc.test.ts
git commit -m "refactor(ipc): remove legacy IPC constant object (#8)"
```

---

## Task 13: 端到端冒烟 + 更新 ROADMAP

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三者全绿。

- [ ] **Step 2: 真实 GUI 冒烟（手测）**

Run: `pnpm start`
逐项确认（覆盖三类特殊通道 + 常规 invoke）：

- 书库显示、拖拽导入一本 ePub（`library.pathForFile` 非 IPC 路径 + `library:import`）。
- 打开书、跳章、保存进度（`content:*` / `progress:*`）。
- 选区 → 工具栏 → 发消息 → **流式回复**（`ai:send` + `ai:chunk` event 推流）。
- 设置页：列 provider、拉模型、测试（`providers:*`）。
- 标注：高亮、编辑、笔记、侧栏列表（`annotations:*`）。
- 重启 app 后主题/语言正确（`preferences:get-all-sync` + `app:get-locale-sync` 两个 sync 通道首帧快照）。
  Expected: 全部正常，控制台无 `[ipc] … failed` 报错。

- [ ] **Step 3: 更新 `docs/superpowers/ROADMAP.md`**

在「基建 / 重构」表把 #8 行状态从 `🔴` 改为 `✅`，并在备注追加交付摘要。定位该行：

```markdown
| **IPC 契约注册表重构**：把 channel/input/output/preload method/main handler 绑定关系收敛到声明式 registry，减少 `src/shared/*` schema、`src/shared/ipc.ts` 通道名、`src/preload.ts` 手写 API、`src/main/ipc/*-handlers.ts` 之间的人肉同步。目标是新增/改 IPC 时类型和运行时校验同源，preload 映射可机械生成或由统一定义派生。 | 🔴 | #8（#7 架构债） |
```

改为：

```markdown
| **IPC 契约注册表重构（已交付，#8）**：契约 map `C`（`src/shared/ipc.ts`）为单一源——每通道一条 `{channel,kind,input schema,output 类型}`；`bind(C.x,fn)` 产出纯数据 Binding、`register()` 唯一碰 ipcMain（绕开 RUN_AS_NODE 下 ipcMain 为 undefined 的测试约束）；preload 改 `createApi(注入依赖)` 纯函数 + `invoker(C.x)`，类型由契约派生、零手写标注、renderer 零改动。三个纯数据漂移测试（契约完整性 / bindings 覆盖 / preload 覆盖）兜底。`conversations:create/get` 为 main-only（有 handler、preload 不暴露）。 | ✅ | #8（#7 架构债） |
```

并在文件顶部「当前焦点」区，给 #8 加一句交付记录（与既有 #9 同风格），日期 2026-06-03。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): mark #8 (IPC contract registry) delivered"
```

- [ ] **Step 5: 收尾**

调用 `superpowers:finishing-a-development-branch` 决定合并/PR/清理（按本仓「合并即更新 ROADMAP」约定，ROADMAP 已在 Step 3 更新）。

---

## 自审记录（实现者无需理会，供追溯）

- **Spec 覆盖**：§4.1 契约 map → Task 1；§4.3 bind/register → Task 2/10；§4.3 invoker/createApi → Task 11；§4.2 三 kind（invoke 经 bind、sync 手写 ipcMain.on、event 经 send/onChunk）→ Task 3/8/9/11；§5 三测试 → Task 1（完整性）/10（bindings 覆盖）/11（preload 覆盖）；§6 改动清单逐文件 → Task 1–12；§7 成功判据 → Task 13。
- **main-only 通道** `conversations:create/get`：bindings 覆盖测试要求其**有** binding（Task 6 已含）；preload 覆盖测试把其列入 `KNOWN_MAIN_ONLY` 豁免（Task 11）——两测试方向相反、各自正确。
- **运行时约束**：`ELECTRON_RUN_AS_NODE=1` 下 `ipcMain`/`app` 为 `undefined`（已实测），故所有测试只读纯数据（contract / bindings 数组 / createApi 注入 mock），不调用 `register`/`registerXHandlers`，不碰真 `ipcMain`。
- **绿色提交**：Task 2 共存策略（保留 `handle`）使 Task 3–9 逐文件迁移皆绿；Task 10 删 `handle` 时已无消费方。
