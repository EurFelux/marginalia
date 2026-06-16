# reader 上下文合并 library 工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让阅读器（reader）上下文的 AI 同时拥有书库（library）只读工具，并为当前书新增一个无参的 `getBookSummary` 工具。

**Architecture:** 三处主进程改动 + 一个新纯函数。`tools.ts` 给 reading 工具集加 `getBookSummary`（闭包绑当前 `bookId`，复用 `getBookSummaryView`）。新建 `context-tools.ts` 把「按 `bookId` 空/非空组装上下文工具集」抽成可单测纯函数（reader = reading + library；library = 仅 library），`stream-assistant.ts` 改为调用它。`base-prompt.ts` 把 library 工具说明抽成单一真相源片段，reader 模板追加该片段。`send.ts` 不动。

**Tech Stack:** TypeScript 6 / Vercel AI SDK v6 `tool()` / Drizzle ORM + better-sqlite3 / vitest（跑在 Electron 运行时）。

设计依据：`docs/superpowers/specs/2026-06-16-reader-library-tools-design.md`（Issue [#98](https://github.com/EurFelux/marginalia/issues/98)）。

**前置：** 当前已在分支 `feat/reader-library-tools`（spec 已提交）。所有任务在此分支提交。

---

## File Structure

- **Modify** `src/main/ai/tools.ts` — `createReadingTools` 的 `base` 新增 `getBookSummary`；加 `getBookSummaryView` import。
- **Modify** `src/main/ai/tools.test.ts` — `getBookSummary` 两个用例；加 `books` / `eq` import。
- **Create** `src/main/ai/context-tools.ts` — `createContextTools(deps)` 纯函数：按 `bookId` 组装上下文工具集。
- **Create** `src/main/ai/context-tools.test.ts` — 组装断言（reader 含两套键 / library 仅一套）。
- **Modify** `src/main/ai/stream-assistant.ts:75-77` — 用 `createContextTools` 替换互斥 if-else。
- **Modify** `src/main/ai/base-prompt.ts` — 新增 `LIBRARY_TOOLS_FRAGMENT` 常量 + reader 追加段；重组 `LIBRARY_SYSTEM_PROMPT` 复用片段。
- **Modify** `src/main/ai/base-prompt.test.ts` — book kind 含 library 片段断言；加 `LIBRARY_TOOLS_FRAGMENT` import。
- **Create** `.changeset/reader-library-tools.md` — 用户向 changelog 条目。

---

## Task 1: reading 工具新增 `getBookSummary`

**Files:**

- Modify: `src/main/ai/tools.ts:8` (import)、`src/main/ai/tools.ts:82-113` (`base` 对象)
- Test: `src/main/ai/tools.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/ai/tools.test.ts` 顶部 import 区（第 9 行 `createReadingTools` import 之后）补两个 import：

```ts
import { eq } from "drizzle-orm";
import { books } from "@main/db/schema";
```

在 `describe("createReadingTools", ...)` 块内、`getChapterSummary` 用例（约第 77 行 `});` 之后）插入：

```ts
it("getBookSummary returns the whole-book summary state (pending when none)", async () => {
  const { tools } = await setup();
  expect(await tools.getBookSummary.execute!({}, opts)).toEqual({
    status: "pending",
    summary: null,
  });
});

it("getBookSummary returns the stored whole-book summary when present", async () => {
  const { db, book, tools } = await setup();
  db.update(books).set({ summary: "the whole-book gist" }).where(eq(books.id, book.id)).run();
  expect(await tools.getBookSummary.execute!({}, opts)).toEqual({
    status: "ready",
    summary: "the whole-book gist",
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test src/main/ai/tools.test.ts -t "getBookSummary"`
Expected: FAIL —— `tools.getBookSummary` 为 `undefined`（`Cannot read properties of undefined (reading 'execute')`）。

- [ ] **Step 3: 实现 `getBookSummary`**

在 `src/main/ai/tools.ts` 第 8 行（`import { getChapterSummaryView } from "@main/ai/summary";`）改为同时导入 `getBookSummaryView`：

```ts
import { getChapterSummaryView, getBookSummaryView } from "@main/ai/summary";
```

在 `createReadingTools` 的 `base` 对象里、`getChapterSummary` 之后（第 97 行 `}),` 之后）插入：

```ts
    getBookSummary: tool({
      description:
        "Get the AI-generated whole-book summary (and its status) for the book you're reading. No arguments — it always targets the current book.",
      inputSchema: z.object({}),
      execute: async () => runTool("getBookSummary", () => getBookSummaryView(db, bookId)),
    }),
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm test src/main/ai/tools.test.ts`
Expected: PASS（含新增 2 个 + 原有用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/tools.ts src/main/ai/tools.test.ts
git commit -m "feat(ai): add getBookSummary reading tool for the current book

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> pre-commit hook（prek）会跑 lint:fix + format；若它改了文件并中止提交，`git add` 被改文件后重跑同一条 commit 即可。

---

## Task 2: `createContextTools` 纯函数

**Files:**

- Create: `src/main/ai/context-tools.ts`
- Test: `src/main/ai/context-tools.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/ai/context-tools.test.ts`：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createContextTools } from "@main/ai/context-tools";
import { type LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const noopLoad: LoadBytes = async () => new Uint8Array();

const READING_KEYS = ["getToc", "readChapterText", "getChapterSummary", "getBookSummary"];
const LIBRARY_KEYS = ["listBooks", "getBook", "getBookNotes", "listAnnotations", "getReadingStats"];

describe("createContextTools", () => {
  it("reader context (bookId set) exposes both reading and library tools", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const tools = createContextTools({ db, bookId: book.id, loadBytes: noopLoad });
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(READING_KEYS));
    expect(keys).toEqual(expect.arrayContaining(LIBRARY_KEYS));
  });

  it("library context (bookId null) exposes only library tools", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const tools = createContextTools({ db, bookId: null, loadBytes: noopLoad });
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(LIBRARY_KEYS));
    for (const k of READING_KEYS) expect(keys).not.toContain(k);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test src/main/ai/context-tools.test.ts`
Expected: FAIL —— 无法解析 `@main/ai/context-tools`（模块不存在）。

- [ ] **Step 3: 实现 `createContextTools`**

创建 `src/main/ai/context-tools.ts`：

```ts
// src/main/ai/context-tools.ts —— 按上下文组装"上下文工具集"（spec 2026-06-16-reader-library-tools §3.2）。
// reader（bookId 非空）= 阅读工具 + 书库工具；library（bookId 为 null）= 仅书库工具。
// memory / search 工具在 stream-assistant 另行合并（各有门控），不在此处。
import type { DB } from "@main/db/client";
import { createReadingTools, type LoadBytes } from "@main/ai/tools";
import { createLibraryTools } from "@main/ai/library-tools";

export interface ContextToolsDeps {
  db: DB;
  /** null = 书库上下文；非空 = 阅读器上下文（当前书 id）。 */
  bookId: string | null;
  loadBytes: LoadBytes;
  /** provider 是否支持图像 tool result（透传给 reading 工具的 readPage 门控）。 */
  imageToolResults?: boolean;
}

export function createContextTools(deps: ContextToolsDeps) {
  const { db, bookId, loadBytes, imageToolResults } = deps;
  const library = createLibraryTools({ db });
  if (bookId == null) return library;
  return {
    ...createReadingTools({ db, bookId, loadBytes, imageToolResults }),
    ...library,
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm test src/main/ai/context-tools.test.ts`
Expected: PASS（两个用例均绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/context-tools.ts src/main/ai/context-tools.test.ts
git commit -m "feat(ai): add createContextTools to assemble reader/library tool sets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `stream-assistant` 接入 `createContextTools`

**Files:**

- Modify: `src/main/ai/stream-assistant.ts:11-13` (imports)、`src/main/ai/stream-assistant.ts:75-77` (组装)

本任务无新单测——组装逻辑已由 Task 2 覆盖；这里只把内联 if-else 替换为函数调用，验证靠 typecheck + 全量测试不回归。

- [ ] **Step 1: 替换组装逻辑**

在 `src/main/ai/stream-assistant.ts` 顶部 import 区：删除第 11 行 `import { createReadingTools } from "@main/ai/tools";` 和第 13 行 `import { createLibraryTools } from "@main/ai/library-tools";`，新增：

```ts
import { createContextTools } from "@main/ai/context-tools";
```

（第 12 行 `import { createMemoryTools } from "@main/ai/memory-tools";` 保留。）

把第 75-77 行：

```ts
const contextTools = bookId
  ? createReadingTools({ db, bookId, loadBytes, imageToolResults })
  : createLibraryTools({ db });
```

替换为：

```ts
const contextTools = createContextTools({ db, bookId, loadBytes, imageToolResults });
```

（`db` / `loadBytes` 来自 `deps`，`bookId` / `imageToolResults` 已在本函数上文解构与计算，类型 `string | null` 与 `createContextTools` 入参一致。）

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS（无未使用 import 报错、无类型不匹配）。

- [ ] **Step 3: 跑相关测试，确认不回归**

Run: `pnpm test src/main/ai/send.test.ts src/main/ai/context-tools.test.ts src/main/ai/tools.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/main/ai/stream-assistant.ts
git commit -m "refactor(ai): assemble reader context tools via createContextTools

Reader context now merges reading + library tools (closes the
reader->library gap); library context unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: reader system prompt 追加 library 工具片段

**Files:**

- Modify: `src/main/ai/base-prompt.ts:7-9` (常量)、`src/main/ai/base-prompt.ts:29` (template 选择)
- Test: `src/main/ai/base-prompt.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/ai/base-prompt.test.ts` 第 7 行 import 增加 `LIBRARY_TOOLS_FRAGMENT`：

```ts
import {
  BASE_SYSTEM_PROMPT,
  LIBRARY_SYSTEM_PROMPT,
  LIBRARY_TOOLS_FRAGMENT,
  buildSystemPrompt,
} from "@main/ai/base-prompt";
```

在 `describe("buildSystemPrompt — library kind", ...)` 块（约第 56 行 `});` 结束）之后，新增一个 describe：

```ts
describe("buildSystemPrompt — book kind library tools", () => {
  it("appends the shared library tools fragment to the reading-companion base", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-book"); // kind 默认 book
    expect(text.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain(LIBRARY_TOOLS_FRAGMENT);
    expect(text).toContain("listBooks");
  });

  it("library kind reuses the same fragment (single source of truth)", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-lib", "library");
    expect(text).toContain(LIBRARY_TOOLS_FRAGMENT);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test src/main/ai/base-prompt.test.ts`
Expected: FAIL —— `LIBRARY_TOOLS_FRAGMENT` 未导出（import 解析失败 / 值为 undefined，book kind 用例 `toContain(undefined)` 报错或 fragment 不在文本中）。

- [ ] **Step 3: 实现片段抽取 + reader 追加**

在 `src/main/ai/base-prompt.ts` 把第 7-9 行（`BASE_SYSTEM_PROMPT` 与 `LIBRARY_SYSTEM_PROMPT` 定义）替换为：

```ts
export const BASE_SYSTEM_PROMPT = `You are a reading companion embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely, and always respond in the language the user is using.`;

// 书库工具能力描述：reader 追加段与 library 主模板共用的单一真相源（spec §3.3）。
export const LIBRARY_TOOLS_FRAGMENT = `Tools for the reader's whole library: listBooks (the catalog with reading state), getBook (a book's details and AI summary), getBookNotes and listAnnotations (what the reader wrote), getReadingStats (how they read). Ground every claim and recommendation in tool results and the reader's memory — never invent books they don't own.`;

// reader 上下文：当前书之外，也能纵览整个书库（接在 BASE_SYSTEM_PROMPT 之后）。
const READER_LIBRARY_ADDENDUM = `Beyond the book in front of you, you can also explore the reader's whole library. Stay focused on the book they're reading — use the reading tools and getBookSummary for it — and reach for the library tools when they ask about other books, their whole collection, recommendations, reading stats, or comparisons across books.`;

export const LIBRARY_SYSTEM_PROMPT = `You are a personal librarian embedded in the reader's e-book app, talking with them at their library (not inside any one book).

${LIBRARY_TOOLS_FRAGMENT}

Help them discuss their collection and decide what to read next; explain recommendations from their history and stated tastes. Answer concisely, and always respond in the language the reader is using.`;
```

再把第 29 行的 template 选择：

```ts
const template = kind === "library" ? LIBRARY_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
```

替换为：

```ts
const template =
  kind === "library"
    ? LIBRARY_SYSTEM_PROMPT
    : `${BASE_SYSTEM_PROMPT}\n\n${READER_LIBRARY_ADDENDUM}\n\n${LIBRARY_TOOLS_FRAGMENT}`;
```

- [ ] **Step 4: 跑测试，确认通过且无回归**

Run: `pnpm test src/main/ai/base-prompt.test.ts`
Expected: PASS —— 新增用例绿；原有用例仍绿（book kind 仍 `startsWith(BASE_SYSTEM_PROMPT)`；library kind 仍 `startsWith(LIBRARY_SYSTEM_PROMPT)` 且不 `startsWith(BASE_SYSTEM_PROMPT)`）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/base-prompt.ts src/main/ai/base-prompt.test.ts
git commit -m "feat(ai): tell the reader assistant about library tools in its prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 全量验证 + changeset（finishing）

**Files:**

- Create: `.changeset/reader-library-tools.md`

- [ ] **Step 1: 全量类型检查 + lint + 测试**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。若 `pnpm test` 报 better-sqlite3 ABI 错，按 CLAUDE.md 排障（正常情况下 vitest 跑在 Electron 运行时，无需翻转）。

- [ ] **Step 2: 写 changeset**

创建 `.changeset/reader-library-tools.md`：

```md
---
"marginalia": minor
---

The in-book AI assistant can now reach your whole library: ask it to compare the current book with others you've read, recall highlights and notes from any book, or check your reading stats — without leaving the book. It also gained a direct way to fetch the current book's whole-book summary.
```

- [ ] **Step 3: 提交 changeset**

```bash
git add .changeset/reader-library-tools.md
git commit -m "chore: add changeset for reader-view library tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: 收尾交接**

报告：分支 `feat/reader-library-tools` 上的全部任务完成、`pnpm typecheck && pnpm lint && pnpm test` 结果。把合并到 `main`（rebase 保线性）与 kanban 挪列（#98 → Done，合并后自动）交回主控决定，不在本计划内自行合并。

---

## 验证（手动冒烟，可选）

主进程改动为无头可测，已由上述单测覆盖。若需端到端确认，可 `pnpm start` 打开任意书 → 在阅读器 AI 面板问「我书架上还有哪些书？」「这本和我读过的 X 比怎样？」，观察 AI 是否调用 `listBooks` / `getBook` 等工具并据实回答（DevTools / 日志 module=`send` 可见 step / tool 调用）。
