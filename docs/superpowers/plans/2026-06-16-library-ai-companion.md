# 书库 AI 伴侣 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI（Lia）拥有访问整个书库的能力——书库视图可呼出全局悬浮助手，基于书目 + 阅读历史 + 全局记忆讨论藏书、推荐下一本读什么。

**Architecture:** 引入 `ChatContext`（`book | library`）作为唯一上下文开关。会话与书解耦（`conversations.bookId` 可空），library 上下文用一套只读「书库工具」（listBooks/getBook/notes/annotations/stats）按需拉数据；渲染层把 `AIPanel` 从「写死 currentBookId」泛化为「由容器注入 context」，同一组件既塞进阅读器停靠分栏（book），又塞进书库悬浮浮层（library）。

**Tech Stack:** Electron 主进程（TS）+ Drizzle ORM/better-sqlite3 + Vercel AI SDK v6 + Zod 4 + React 19 + zustand + TanStack Query + vitest 4。

**Spec:** `docs/superpowers/specs/2026-06-16-library-ai-companion-design.md`

**前置约定（每个 task 通用）:**

- 测试运行器：`pnpm test <file>`（vitest 跑在 Electron 运行时；详见 CLAUDE.md）。
- 主进程业务为纯函数注入 DB，用 `:memory:` SQLite 测；`runMigrations(db, MIGRATIONS)` 的 `MIGRATIONS = path.resolve(__dirname, "../db/migrations")`。
- 提交信息用 Conventional Commits；分支已在 `feat/library-ai-companion`。
- 单个 commit 触发 prek（lint:fix + format），若报「files were modified by this hook」则 `git add` 被改文件后重跑同一 commit。

---

## File Structure

**主进程（Phase A，全部 headless 可测）:**

- Modify `src/main/db/schema.ts` — `conversations.bookId` 去 `notNull`
- Generate `src/main/db/migrations/<new>/` — `pnpm db:generate`
- Modify `src/shared/chat.ts` — `ConversationDto.bookId` 可空、`createConversationInput`/`sendInputSchema` 放宽、新增 `listConversationsInput`
- Modify `src/shared/ipc.ts` — `conversationsListByBook` 改用 `listConversationsInput`
- Modify `src/main/chat/conversations.ts` — `createConversation`/`listConversationsByBook` 走 null 路径
- Create `src/main/ai/library-tools.ts` (+ `library-tools.test.ts`) — 书库只读工具
- Modify `src/main/ai/tools.ts` — 导出 `runTool` 供复用
- Modify `src/main/ai/base-prompt.ts` — 新增 `LIBRARY_SYSTEM_PROMPT` + `buildSystemPrompt(db, conversationId, kind)`
- Modify `src/main/ai/send.ts` + `src/main/ai/stream-assistant.ts` — 线程化可空 bookId + 工具分流

**渲染层（Phase B）:**

- Create `src/renderer/ai/chat-context.ts` (+ test) — `ChatContext` 类型 + `contextKey` + `deriveChatContext`
- Modify `src/renderer/store/chat-store.ts` — 加 `activeLibraryConversation`、helpers 收 context
- Modify `src/renderer/query/conversation-queries.ts` — `conversationsQuery(context)`
- Modify `src/renderer/ai/ipc-chat-transport.ts` — `createIpcChatTransport(context)`
- Modify `src/renderer/ai/AIPanel.tsx` — 加 `context` + `onClose` props
- Modify `src/renderer/reader/ConversationsTab.tsx` + `src/renderer/reader/Sidebar.tsx` — 收 context
- Modify `src/renderer/reader/ReaderView.tsx` — 传 book context + onClose
- Create `src/renderer/ai/FloatingAssistant.tsx` — 悬浮容器
- Modify `src/renderer/shell/AppShell.tsx` — 挂载 FloatingAssistant
- Modify `src/shared/i18n/locales/{en,zh-CN}.ts` — librarian 文案（经 i18n:extract）

---

## Phase A — 主进程

### Task 1: `conversations.bookId` 可空（schema + 迁移）

**Files:**

- Modify: `src/main/db/schema.ts:171-174`
- Generate: `src/main/db/migrations/<timestamp>_<name>/`
- Test: `src/main/chat/conversations.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `conversations.test.ts` 末尾追加一个直插 null bookId 的 client 级测试：

```ts
import { isNull } from "drizzle-orm"; // 确保已在文件顶部 import（drizzle-orm 已有 eq）

describe("library conversations (null bookId)", () => {
  it("allows inserting a conversation row with null bookId", () => {
    const db = freshDb();
    const row = db.insert(conversations).values({ bookId: null }).returning().get();
    expect(row.bookId).toBeNull();
    const back = db.select().from(conversations).where(isNull(conversations.bookId)).all();
    expect(back).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversations.test.ts -t "null bookId"`
Expected: FAIL —迁移仍带 `NOT NULL`，插入 null 抛 `NOT NULL constraint failed: conversations.book_id`。

- [ ] **Step 3: 改 schema 去掉 notNull**

`src/main/db/schema.ts`，把 conversations 表的 bookId 由：

```ts
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
```

改为（保留 FK + cascade，仅去 notNull）：

```ts
    // 可空：bookId IS NULL ⇒ 书库（library）会话（spec 2026-06-16 §3）。FK + cascade 不变。
    bookId: text("book_id").references(() => books.id, { onDelete: "cascade" }),
```

- [ ] **Step 4: 生成迁移**

Run: `pnpm db:generate`
Expected: 新增 `src/main/db/migrations/<timestamp>_*/`（含 `migration.sql` + `snapshot.json`），SQL 为 conversations 表重建（去掉 book_id 的 NOT NULL）。**勿手工编辑**生成物。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: PASS（含新用例与原有用例）。

- [ ] **Step 6: 提交**

```bash
git add src/main/db/schema.ts src/main/db/migrations src/main/chat/conversations.test.ts
git commit -m "feat(db): make conversations.bookId nullable for library conversations"
```

---

### Task 2: 契约放宽（`@shared/chat` + `ipc.ts`）

**Files:**

- Modify: `src/shared/chat.ts`
- Modify: `src/shared/ipc.ts:252-257`
- Test: `src/shared/chat.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `src/shared/chat.test.ts` 追加：

```ts
import { createConversationInput, sendInputSchema, listConversationsInput } from "@shared/chat";

describe("nullable bookId contract", () => {
  it("createConversationInput accepts omitted and null bookId", () => {
    expect(createConversationInput.parse({}).bookId ?? null).toBeNull();
    expect(createConversationInput.parse({ bookId: null }).bookId).toBeNull();
    expect(createConversationInput.parse({ bookId: "b1" }).bookId).toBe("b1");
  });
  it("sendInputSchema accepts null bookId", () => {
    const parsed = sendInputSchema.parse({
      bookId: null,
      conversationId: "c1",
      chips: [],
      userText: "hi",
    });
    expect(parsed.bookId).toBeNull();
  });
  it("listConversationsInput accepts string or null", () => {
    expect(listConversationsInput.parse({ bookId: null }).bookId).toBeNull();
    expect(listConversationsInput.parse({ bookId: "b1" }).bookId).toBe("b1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/chat.test.ts -t "nullable bookId"`
Expected: FAIL — `listConversationsInput` 未导出 / `sendInputSchema` 拒绝 null bookId。

- [ ] **Step 3: 改 `@shared/chat`**

(a) `createConversationInput`（当前 `bookId: z.string().min(1)`）→：

```ts
/** conversations:create 入参。bookId 省略/为 null ⇒ 书库（library）会话（spec 2026-06-16 §4.1）。 */
export const createConversationInput = z.object({
  bookId: z.string().min(1).nullable().optional(),
});
```

(b) 新增（紧随 `createConversationInput` 之后）：

```ts
/** conversations:list-by-book 入参。bookId 为 null ⇒ 列出书库会话（bookId IS NULL）。 */
export const listConversationsInput = z.object({
  bookId: z.string().min(1).nullable(),
});
export type ListConversationsInput = z.infer<typeof listConversationsInput>;
```

(c) `ConversationDto.bookId`：`bookId: string;` → `bookId: string | null;`（并更新其上方注释「bookId 恒非空」为「bookId 为 null ⇒ 书库会话」）。

(d) `sendInputSchema.bookId`（当前 `z.string().min(1)`）→ `z.string().min(1).nullable()`，注释补「null ⇒ 书库上下文」。

- [ ] **Step 4: 改 `ipc.ts` 通道入参**

`src/shared/ipc.ts`：在顶部 import 块（与 `createConversationInput` 同处，约 line 36）加入 `listConversationsInput`；把 `conversationsListByBook` 的 `bookIdInput` 换成 `listConversationsInput`：

```ts
  conversationsListByBook: def(
    "conversations:list-by-book",
    "invoke",
    listConversationsInput,
    out<ConversationDto[]>(),
  ),
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm test src/shared/chat.test.ts && pnpm typecheck`
Expected: chat.test.ts PASS；typecheck 此时**预期报错**——`conversations.ts`、`AIPanel.tsx`、`ConversationsTab.tsx`、`ipc-chat-transport.ts`、`conversation-queries.ts` 等仍按 `bookId: string` 假设。这些在后续 task 修复，**本步只确认 chat.test.ts 绿**；typecheck 报错清单留作后续 task 的对照。

- [ ] **Step 6: 提交**

```bash
git add src/shared/chat.ts src/shared/ipc.ts src/shared/chat.test.ts
git commit -m "feat(chat): widen conversation/send contracts to nullable bookId"
```

---

### Task 3: 会话仓库 null 路径（`chat/conversations.ts`）

**Files:**

- Modify: `src/main/chat/conversations.ts`
- Test: `src/main/chat/conversations.test.ts`

- [ ] **Step 1: 写失败测试** — 追加：

```ts
describe("createConversation / listConversationsByBook for library (null bookId)", () => {
  it("creates a library conversation when bookId is null/omitted", () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: null });
    expect(convo.bookId).toBeNull();
    expect(getConversation(db, convo.id)?.bookId ?? null).toBeNull();
  });

  it("reuses an existing empty library conversation (anti-pileup)", () => {
    const db = freshDb();
    const a = createConversation(db, {});
    const b = createConversation(db, {});
    expect(b.id).toBe(a.id);
  });

  it("listConversationsByBook(null) lists only library conversations", () => {
    const db = freshDb();
    seedBookWithChapters(db); // book-1
    const lib = createConversation(db, { bookId: null });
    const booky = createConversation(db, { bookId: "book-1" });
    const libList = listConversationsByBook(db, null);
    expect(libList.map((c) => c.id)).toEqual([lib.id]);
    const bookList = listConversationsByBook(db, "book-1");
    expect(bookList.map((c) => c.id)).toEqual([booky.id]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversations.test.ts -t "library (null bookId)"`
Expected: FAIL — `createConversation` 对 null 用 `eq(bookId, null)`（永不命中且类型不符）/ 插入 undefined；`listConversationsByBook` 签名不接受 null。

- [ ] **Step 3: 改 `conversations.ts`**

(a) 顶部 import 加 `isNull`：`import { and, desc, eq, isNull } from "drizzle-orm";`（`isNull` 已在用，确认即可）。

(b) `createConversation` 改为 null-aware：

```ts
export function createConversation(db: DB, input: CreateConversationInput): ConversationDto {
  const bookId = input.bookId ?? null;
  const bookMatch =
    bookId === null ? isNull(conversations.bookId) : eq(conversations.bookId, bookId);
  const empty = db
    .select({ row: conversations })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(bookMatch, isNull(messages.id)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  if (empty) return toDto(empty.row);

  const row = db.insert(conversations).values({ bookId }).returning().get();
  return toDto(row);
}
```

(c) `listConversationsByBook` 泛化为接受 `string | null`：

```ts
/** 列出某书的会话（bookId 为 null ⇒ 书库会话），最近更新在前。 */
export function listConversationsByBook(db: DB, bookId: string | null): ConversationDto[] {
  const match = bookId === null ? isNull(conversations.bookId) : eq(conversations.bookId, bookId);
  return db
    .select()
    .from(conversations)
    .where(match)
    .orderBy(desc(conversations.updatedAt))
    .all()
    .map(toDto);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: PASS（含新用例 + 原有 book 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/chat/conversations.ts src/main/chat/conversations.test.ts
git commit -m "feat(chat): support null-bookId (library) conversations in repository"
```

---

### Task 4: 书库工具（`ai/library-tools.ts`）

**Files:**

- Modify: `src/main/ai/tools.ts:66-73`（导出 `runTool`）
- Create: `src/main/ai/library-tools.ts`
- Test: `src/main/ai/library-tools.test.ts`

- [ ] **Step 1: 导出 `runTool`** — `src/main/ai/tools.ts` 把 `async function runTool` 改为 `export async function runTool`（其余不动）。

- [ ] **Step 2: 写失败测试** — 创建 `src/main/ai/library-tools.test.ts`：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, progress, annotations, bookNotes } from "@main/db/schema";
import { createLibraryTools } from "@main/ai/library-tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

async function run(tool: { execute: (a: unknown) => unknown }, args: unknown = {}) {
  return await tool.execute(args);
}

describe("createLibraryTools", () => {
  it("listBooks returns the catalog with progress + finished flags", async () => {
    const db = freshDb();
    db.insert(books)
      .values({ id: "b1", title: "Stoicism", author: "M.A.", isFinished: false })
      .run();
    db.insert(books).values({ id: "b2", title: "Done", isFinished: true }).run();
    db.insert(progress).values({ bookId: "b1", locator: "loc", percent: 0.4 }).run();
    const tools = createLibraryTools({ db });
    const list = (await run(tools.listBooks)) as Array<Record<string, unknown>>;
    expect(list.map((b) => b.id).sort()).toEqual(["b1", "b2"]);
    const b1 = list.find((b) => b.id === "b1")!;
    expect(b1.title).toBe("Stoicism");
    expect(b1.progressPercent).toBe(0.4);
    expect(b1.isFinished).toBe(false);
  });

  it("getBook returns details; unknown id returns an error hint", async () => {
    const db = freshDb();
    db.insert(books).values({ id: "b1", title: "T", summary: "the gist" }).run();
    const tools = createLibraryTools({ db });
    const ok = (await run(tools.getBook, { bookId: "b1" })) as Record<string, unknown>;
    expect(ok.title).toBe("T");
    expect(ok.summary).toBe("the gist");
    const bad = (await run(tools.getBook, { bookId: "nope" })) as Record<string, unknown>;
    expect(bad.error).toBeTypeOf("string");
  });

  it("getBookNotes + listAnnotations return per-book entries", async () => {
    const db = freshDb();
    db.insert(books).values({ id: "b1", title: "T" }).run();
    db.insert(bookNotes).values({ bookId: "b1", content: "my note" }).run();
    db.insert(annotations)
      .values({
        bookId: "b1",
        style: "yellow",
        note: "",
        selectedText: "passage",
        locatorRange: "r",
      })
      .run();
    const tools = createLibraryTools({ db });
    const notes = (await run(tools.getBookNotes, { bookId: "b1" })) as Array<
      Record<string, unknown>
    >;
    expect(notes[0].content).toBe("my note");
    const anns = (await run(tools.listAnnotations, { bookId: "b1" })) as Array<
      Record<string, unknown>
    >;
    expect(anns[0].selectedText).toBe("passage");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/ai/library-tools.test.ts`
Expected: FAIL — `library-tools.ts` 不存在。

- [ ] **Step 4: 实现 `library-tools.ts`**

```ts
// src/main/ai/library-tools.ts —— library 上下文的只读书库工具（spec 2026-06-16 §4.4）。
// 纯函数注入 DB；失败转 { error } 不抛（沿用 tools.ts 的 runTool 纪律，模型自纠）。
import { tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { runTool } from "@main/ai/tools";
import { listBooks, listRecentlyRead, getBook } from "@main/library/repository";
import { getBookSummaryView } from "@main/ai/summary";
import { listBookNotesByBook } from "@main/library/book-notes";
import { listAnnotationsByBook } from "@main/library/annotations";

export interface LibraryToolsDeps {
  db: DB;
}

export function createLibraryTools(deps: LibraryToolsDeps) {
  const { db } = deps;
  return {
    listBooks: tool({
      description:
        "List every book in the reader's library with reading state. Returns id, title, author, format, isFinished, progressPercent (0–1 or null), lastReadAt (ms or null). Start here to ground any recommendation or discussion.",
      inputSchema: z.object({}),
      execute: async () => {
        // listBooks 给全量目录；listRecentlyRead 给 percent/lastReadAt（按书 join progress）。
        const recent = new Map(listRecentlyRead(db, Number.MAX_SAFE_INTEGER).map((r) => [r.id, r]));
        return listBooks(db).map((b) => {
          const r = recent.get(b.id);
          return {
            id: b.id,
            title: b.title,
            author: b.author,
            format: b.format,
            isFinished: b.isFinished,
            progressPercent: r?.percent ?? null,
            lastReadAt: r?.lastReadAt ?? null,
          };
        });
      },
    }),
    getBook: tool({
      description:
        "Get one book's details by its id (from listBooks): title, author, format, pageCount, isFinished, addedAt, and its AI book summary (status + text if ready).",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) =>
        runTool("getBook", () => {
          const book = getBook(db, bookId);
          if (!book) {
            throw new Error(`book not found: "${bookId}". Call listBooks and pass an exact id.`);
          }
          const summary = getBookSummaryView(db, bookId);
          return {
            title: book.title,
            author: book.author,
            format: book.format,
            pageCount: book.pageCount,
            isFinished: book.isFinished,
            addedAt: book.addedAt,
            summaryStatus: summary.status,
            summary: summary.summary ?? null,
          };
        }),
    }),
    getBookNotes: tool({
      description: "Get the reader's free-form Markdown notes for one book (id from listBooks).",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) => runTool("getBookNotes", () => listBookNotesByBook(db, bookId)),
    }),
    listAnnotations: tool({
      description:
        "List the reader's highlights/annotations for one book (id from listBooks): selectedText, note, style.",
      inputSchema: z.object({ bookId: z.string().min(1) }),
      execute: async ({ bookId }) =>
        runTool("listAnnotations", () =>
          listAnnotationsByBook(db, bookId).map((a) => ({
            selectedText: a.selectedText,
            note: a.note,
            style: a.style,
          })),
        ),
    }),
  };
}
```

> 注：`getReadingStats` 工具留到 Task 4b（依赖 stats 装配，单独一步以免本 task 过大）。先实现以上四个工具——已覆盖目录/详情/笔记/标注，足以支撑「推荐下一本」核心闭环。

- [ ] **Step 5: 核对 `getBookSummaryView` 返回形状** — 打开 `src/main/ai/summary.ts` 的 `getBookSummaryView`，确认它返回含 `status` 与 `summary` 字段的视图；若字段名不同（如 `text`），在上面 `getBook.execute` 里对齐字段名。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/main/ai/library-tools.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/main/ai/tools.ts src/main/ai/library-tools.ts src/main/ai/library-tools.test.ts
git commit -m "feat(ai): add read-only library tools (listBooks/getBook/notes/annotations)"
```

---

### Task 4b: `getReadingStats` 工具

**Files:**

- Modify: `src/main/ai/library-tools.ts`
- Test: `src/main/ai/library-tools.test.ts`

- [ ] **Step 1: 核对 stats 装配** — 打开 `src/main/ipc/stats-handlers.ts` 与 `src/main/stats/aggregate.ts`，记下 Stats 视图如何从 `reading_daily` 行 + `aggregateStats` + perBook 查询装出 `ReadingStatsDto`（含 `today`/`dailyDays` 参数）。复用同一装配路径（若它已是一个可注入 DB 的纯函数，直接调；否则把 handler 里的装配逻辑提取成 `aggregateReadingStats(db, today, dailyDays)` 纯函数再复用）。

- [ ] **Step 2: 写失败测试** — 追加：

```ts
import { readingDaily } from "@main/db/schema";

it("getReadingStats returns totals over reading_daily", async () => {
  const db = freshDb();
  db.insert(books).values({ id: "b1", title: "T" }).run();
  db.insert(readingDaily).values({ bookId: "b1", day: "2026-06-15", seconds: 600 }).run();
  const tools = createLibraryTools({ db });
  const stats = (await (
    tools as Record<string, { execute: (a: unknown) => unknown }>
  ).getReadingStats.execute({})) as Record<string, unknown>;
  expect(stats.totalSeconds).toBe(600);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/ai/library-tools.test.ts -t "getReadingStats"`
Expected: FAIL — `getReadingStats` 工具不存在。

- [ ] **Step 4: 实现** — 在 `createLibraryTools` 返回对象里加：

```ts
    getReadingStats: tool({
      description:
        "Get the reader's reading-time stats: total seconds, current streak, and per-book seconds. Use to gauge engagement and what they've been into lately.",
      inputSchema: z.object({}),
      execute: async () =>
        runTool("getReadingStats", () => aggregateReadingStats(db)),
    }),
```

并在文件顶部 import 第 1 步确定的装配函数（`aggregateReadingStats` 或等价）。`aggregateReadingStats(db)` 内部用本地日期 today（复用 stats-handlers 既有取 today 的方式，勿用 `Date.now()` 之外受限 API）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/ai/library-tools.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/ai/library-tools.ts src/main/ai/library-tools.test.ts src/main/ipc/stats-handlers.ts src/main/stats/*.ts
git commit -m "feat(ai): add getReadingStats library tool"
```

---

### Task 5: librarian base prompt（`base-prompt.ts`）

**Files:**

- Modify: `src/main/ai/base-prompt.ts`
- Test: `src/main/ai/base-prompt.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `base-prompt.test.ts` 追加：

```ts
import { LIBRARY_SYSTEM_PROMPT } from "@main/ai/base-prompt";

describe("buildSystemPrompt — library kind", () => {
  it("uses the librarian base when kind=library", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-lib", "library");
    expect(text.startsWith(LIBRARY_SYSTEM_PROMPT)).toBe(true);
    expect(text).not.toContain("reading companion");
  });
  it("defaults to the reading-companion base (book) when kind omitted", () => {
    const db = freshDb();
    expect(buildSystemPrompt(db, "conv-book").startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/base-prompt.test.ts -t "library kind"`
Expected: FAIL — `LIBRARY_SYSTEM_PROMPT` 未导出 / `buildSystemPrompt` 不接受第三参。

- [ ] **Step 3: 实现** — `src/main/ai/base-prompt.ts`：

新增导出：

```ts
export const LIBRARY_SYSTEM_PROMPT = `You are a personal librarian embedded in the reader's e-book app, talking with them at their library (not inside any one book). You can access their whole library through tools: listBooks for the catalog and reading state, getBook for a book's details and AI summary, getBookNotes and listAnnotations for what they wrote, getReadingStats for how they read. Ground every claim and recommendation in tool results and the reader's memory — never invent books they don't own. Help them discuss their collection and decide what to read next; explain recommendations from their history and stated tastes. Answer concisely, and always respond in the language the reader is using.`;
```

把 `buildSystemPrompt` 改为接受第三参 `kind`，按 kind 选 base：

```ts
export function buildSystemPrompt(
  db: DB,
  conversationId: string,
  kind: "book" | "library" = "book",
): string {
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  const template = kind === "library" ? LIBRARY_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
  const base = memoryEnabled ? `${template}\n\n${MEMORY_GUIDANCE_PROMPT}` : template;
  const agentContext = getAgentContext(db, conversationId);
  return agentContext.length > 0 ? `${base}\n\n${agentContext}` : base;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/base-prompt.test.ts`
Expected: PASS（含原有 book 用例——它们仍调 2 参，默认 "book"）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/base-prompt.ts src/main/ai/base-prompt.test.ts
git commit -m "feat(ai): add librarian system prompt for library context"
```

---

### Task 6: 发送管线线程化可空 bookId + 工具分流

**Files:**

- Modify: `src/main/ai/send.ts`
- Modify: `src/main/ai/stream-assistant.ts`
- Test: `src/main/ai/send.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `send.test.ts` 追加一个 library 发送用例（复用文件里既有的 `textStreamModel` / `makeDeps` 风格 harness；先读文件确认 deps 工厂名，下面以通用形态给出）：

```ts
it("runSend with null bookId uses the librarian prompt and library tools", async () => {
  const db = freshDb();
  // 不导入任何书；直接建一个 library 会话
  const convo = createConversation(db, { bookId: null });

  let capturedSystem = "";
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      // prompt[0] 为 system 消息
      const sys = prompt.find((m) => m.role === "system");
      capturedSystem = typeof sys?.content === "string" ? sys.content : "";
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Try Meditations." },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });

  const deps: SendDeps = {
    db,
    loadBytes: async () => new Uint8Array(),
    resolveModel: () =>
      ({ ok: true, model, modelId: "m", providerType: "openai-chat-completions" }) as ResolvedModel,
    resolveSummaryModel: () => ({ ok: false, reason: "n/a" }) as ResolvedModel,
    runBackground: passThrough,
  };

  const res = await runSend(deps, {
    bookId: null,
    conversationId: convo.id,
    chips: [],
    userText: "what should I read next?",
  });
  expect(res.ok).toBe(true);
  if (res.ok) await res.finished;
  expect(capturedSystem.startsWith("You are a personal librarian")).toBe(true);
  // 落库的 assistant 消息存在
  const msgs = listMessages(db, convo.id);
  expect(msgs.some((m) => m.role === "assistant")).toBe(true);
});
```

> 若 `send.test.ts` 已有 `makeDeps()`/`baseDeps` 工厂，用它替换上面手搓的 `deps`，仅覆盖 `resolveModel` 返回上面的 `model`。`ResolvedModel` 的 ok 形状字段以文件顶部既有用法为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/send.test.ts -t "null bookId uses the librarian"`
Expected: FAIL — 当前 `runSend` 的 `input.bookId` 为 `string`，且 `buildSystemPrompt` 仍 2 参（书 prompt），工具走 `createReadingTools`。

- [ ] **Step 3: 改 `send.ts`**

(a) `runSend`：`getBook` 与 PDF note 仅在 bookId 非空时执行，并把 buildSystemPrompt 的 kind 传入。把第 82-99 行附近改为：

```ts
// 5. 组装 prompt：library 上下文走 librarian 模板、无 PDF note
const book = input.bookId ? getBook(db, input.bookId) : undefined;
const imageToolResults = supportsImageToolResults(resolved.providerType);
let systemPromptText = buildSystemPrompt(db, conversationId, input.bookId ? "book" : "library");
if (book?.format === "pdf") {
  const note = pdfSystemNote({
    pageCount: book.pageCount,
    hasTextLayer: Boolean(book.hasTextLayer),
    imageMode: imageToolResults,
  });
  systemPromptText = `${systemPromptText}\n\n${note}`;
}
```

并把传给 `streamAssistantReply` 的 ctx 中 `bookId: input.bookId`（现已是 `string | null`）。

(b) `runResend`：同理——`const book = convo.bookId ? getBook(db, convo.bookId) : undefined;` 与 `buildSystemPrompt(db, input.conversationId, convo.bookId ? "book" : "library")`；传 ctx 的 `bookId: convo.bookId`。

- [ ] **Step 4: 改 `stream-assistant.ts`**

(a) `StreamCtx.bookId` 类型 `string` → `string | null`。

(b) 顶部 import 加 `import { createLibraryTools } from "@main/ai/library-tools";`。

(c) 工具组装（第 58-67 行附近）改为按 bookId 分流：

```ts
const { conversationId, bookId, resolved } = ctx;
const imageToolResults = supportsImageToolResults(resolved.providerType);
const memoryTools = createMemoryTools({ db, bookId });
const contextTools = bookId
  ? createReadingTools({ db, bookId, loadBytes, imageToolResults })
  : createLibraryTools({ db });
const tools = {
  ...contextTools,
  ...Object.fromEntries(
    Object.entries(memoryTools).filter(
      (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] != null,
    ),
  ),
};
```

> `loadBytes` 在 library 分支用不到，保留解构不影响。

- [ ] **Step 5: 跑测试确认通过 + 全 ai/chat 套件回归**

Run: `pnpm test src/main/ai/send.test.ts && pnpm test src/main/chat/conversations.test.ts && pnpm test src/main/ai/stream-assistant.test.ts`
Expected: 全 PASS（若无 stream-assistant.test.ts 则跳过该项）。

- [ ] **Step 6: 主进程整体类型检查**

Run: `pnpm typecheck`
Expected: 主进程侧（`src/main`、`src/shared`）**无错**；剩余报错应仅在渲染层（`src/renderer`），由 Phase B 修复。若主进程仍有错，就地修到绿。

- [ ] **Step 7: 提交**

```bash
git add src/main/ai/send.ts src/main/ai/stream-assistant.ts src/main/ai/send.test.ts
git commit -m "feat(ai): route library context to library tools + librarian prompt in send pipeline"
```

---

## Phase B — 渲染层

### Task 7: `ChatContext` 渲染层基元（`chat-context.ts`）

**Files:**

- Create: `src/renderer/ai/chat-context.ts`
- Test: `src/renderer/ai/chat-context.test.ts`

- [ ] **Step 1: 写失败测试** — 创建 `src/renderer/ai/chat-context.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { contextKey, deriveChatContext } from "@renderer/ai/chat-context";

describe("chat-context", () => {
  it("contextKey namespaces book vs library", () => {
    expect(contextKey({ kind: "book", bookId: "b1" })).toBe("book:b1");
    expect(contextKey({ kind: "library" })).toBe("library");
  });
  it("deriveChatContext is book only in reader with a book, else library", () => {
    expect(deriveChatContext("reader", "b1")).toEqual({ kind: "book", bookId: "b1" });
    expect(deriveChatContext("reader", null)).toEqual({ kind: "library" });
    expect(deriveChatContext("library", "b1")).toEqual({ kind: "library" });
    expect(deriveChatContext("stats", null)).toEqual({ kind: "library" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/chat-context.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/renderer/ai/chat-context.ts —— Lia 的上下文脊柱（spec 2026-06-16 §2/§5）。
export type ChatContext = { kind: "book"; bookId: string } | { kind: "library" };

/** 稳定 key：用于 chat-store 槽、TanStack Query key、记忆映射键。 */
export function contextKey(ctx: ChatContext): string {
  return ctx.kind === "book" ? `book:${ctx.bookId}` : "library";
}

/** 由导航派生上下文：阅读器且有书 ⇒ book；否则 ⇒ library。 */
export function deriveChatContext(
  view: "library" | "stats" | "reader",
  currentBookId: string | null,
): ChatContext {
  return view === "reader" && currentBookId
    ? { kind: "book", bookId: currentBookId }
    : { kind: "library" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/chat-context.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ai/chat-context.ts src/renderer/ai/chat-context.test.ts
git commit -m "feat(renderer): add ChatContext spine (book | library)"
```

---

### Task 8: chat-store 收 context + 保 `activeByBook`

**Files:**

- Modify: `src/renderer/store/chat-store.ts`
- Test: `src/renderer/store/chat-store.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `chat-store.test.ts` 追加：

```ts
import { contextKey } from "@renderer/ai/chat-context";

describe("chat-store context-aware active conversation", () => {
  it("book context writes activeByBook; library writes activeLibraryConversation", () => {
    const s = useChatStore.getState();
    s.setActiveConversation({ kind: "book", bookId: "b1" }, "c-book");
    s.setActiveConversation({ kind: "library" }, "c-lib");
    const st = useChatStore.getState();
    expect(st.activeByBook["b1"]).toBe("c-book");
    expect(st.activeLibraryConversation).toBe("c-lib");
    expect(getActiveConversationId({ kind: "book", bookId: "b1" })).toBe("c-book");
    expect(getActiveConversationId({ kind: "library" })).toBe("c-lib");
  });
});
```

> 若现有测试断言 `setActiveConversation(id)` 旧签名，同步更新它们到新签名（带 context）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/chat-store.test.ts -t "context-aware"`
Expected: FAIL — `setActiveConversation` 不接受 context / `activeLibraryConversation` 不存在。

- [ ] **Step 3: 改 `chat-store.ts`**

(a) import：`import type { ChatContext } from "@renderer/ai/chat-context";`（删掉对 `useNavigationStore` 的依赖若 `rememberSlot` 移除后不再需要——确认其它地方是否还用到）。

(b) `ChatState` 加字段：`activeLibraryConversation: string | null;`；`CHAT_INITIAL` 加 `activeLibraryConversation: null`。

(c) 删除 `rememberSlot`；改 `setActiveConversation` / `openConversation` / `restoreConversation` 签名收 `ctx: ChatContext`：

```ts
  setActiveConversation: (ctx, id) =>
    set((s) =>
      ctx.kind === "book"
        ? {
            activeByBook: { ...s.activeByBook, [ctx.bookId]: id },
            ...(id === null ? { openCommand: null } : {}),
          }
        : {
            activeLibraryConversation: id,
            ...(id === null ? { openCommand: null } : {}),
          },
    ),
  openConversation: (ctx, id) => {
    openPanelAndFocusComposer();
    return set((s) => ({
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
      summaryChips: { chapter: false, book: false },
      ...(ctx.kind === "book"
        ? { activeByBook: { ...s.activeByBook, [ctx.bookId]: id } }
        : { activeLibraryConversation: id }),
    }));
  },
  restoreConversation: (ctx, id) =>
    set((s) => ({
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
      summaryChips: { chapter: false, book: false },
      ...(ctx.kind === "book"
        ? { activeByBook: { ...s.activeByBook, [ctx.bookId]: id } }
        : { activeLibraryConversation: id }),
    })),
```

(d) `ChatActions` 接口同步更新这三个方法签名（加 `ctx: ChatContext` 首参）。

(e) persist `partialize`：`(s) => ({ activeByBook: s.activeByBook, activeLibraryConversation: s.activeLibraryConversation })`。

(f) 替换 `useActiveConversationId` / `getActiveConversationId` 为收 context：

```ts
export function useActiveConversationId(ctx: ChatContext): string | null {
  return useChatStore((s) =>
    ctx.kind === "book"
      ? (s.activeByBook[ctx.bookId] ?? null)
      : (s.activeLibraryConversation ?? null),
  );
}

export function getActiveConversationId(ctx: ChatContext): string | null {
  const s = useChatStore.getState();
  return ctx.kind === "book"
    ? (s.activeByBook[ctx.bookId] ?? null)
    : (s.activeLibraryConversation ?? null);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/chat-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/store/chat-store.ts src/renderer/store/chat-store.test.ts
git commit -m "feat(renderer): make chat-store active-conversation slots context-aware"
```

---

### Task 9: 会话列表 query 收 context（`conversation-queries.ts`）

**Files:**

- Modify: `src/renderer/query/conversation-queries.ts`

- [ ] **Step 1: 改实现**

```ts
// src/renderer/query/conversation-queries.ts
import type { ConversationDto } from "@shared/chat";
import { qk } from "@renderer/query/keys";
import { type ChatContext, contextKey } from "@renderer/ai/chat-context";

type IntervalQuery = { state: { data?: ConversationDto[] } };

/** 会话列表 query（按上下文）；book→bookId，library→null。key 用 contextKey 区分。 */
export function conversationsQuery(ctx: ChatContext) {
  const bookId = ctx.kind === "book" ? ctx.bookId : null;
  return {
    queryKey: qk.conversations(contextKey(ctx)),
    queryFn: (): Promise<ConversationDto[]> => window.api.chat.conversations.listByBook({ bookId }),
    staleTime: 0,
    refetchInterval: (q: IntervalQuery) => (q.state.data?.some((c) => c.isNaming) ? 1200 : false),
  } as const;
}
```

> `qk.conversations(key: string)` 签名不变（contextKey 是 string）。`window.api.chat.conversations.listByBook` 入参类型已随 Task 2 放宽为 `{ bookId: string | null }`。

- [ ] **Step 2: 类型检查（局部）**

Run: `pnpm typecheck`
Expected: 本文件无错；调用方（AIPanel/ConversationsTab）仍报错——下个 task 修。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/query/conversation-queries.ts
git commit -m "feat(renderer): key conversation list query by chat context"
```

---

### Task 10: transport 收 context（`ipc-chat-transport.ts`）

**Files:**

- Modify: `src/renderer/ai/ipc-chat-transport.ts`
- Test: `src/renderer/ai/ipc-chat-transport.test.ts`

- [ ] **Step 1: 写失败测试** — 读 `ipc-chat-transport.test.ts` 现有套路后追加一个 library send 用例，断言：library 上下文下不抛「没有正在阅读的书」，且 `window.api.ai.send` 收到 `bookId: null`。（沿用文件既有的 `window.api` mock 方式；若文件用全局 stub，则在用例内 stub `window.api.chat.conversations.create` 返回 `{ id: "c-lib", bookId: null, ... }`、`window.api.ai.send` 记录入参并返回 `{ ok: true, conversationId: "c-lib" }`。）

```ts
it("library context sends with null bookId and lazily creates a library conversation", async () => {
  // navigation: 不在 reader（view=library, currentBookId=null）
  useNavigationStore.setState({ view: "library", currentBookId: null, readingContext: null });
  useChatStore.setState({ activeLibraryConversation: null });
  let sentBookId: unknown = "UNSET";
  window.api.chat.conversations.create = async () => ({
    id: "c-lib",
    bookId: null,
    title: null,
    isNaming: false,
    createdAt: 0,
    updatedAt: 0,
  });
  window.api.ai.send = async (req: { bookId: unknown }) => {
    sentBookId = req.bookId;
    return { ok: true, conversationId: "c-lib" };
  };
  const transport = createIpcChatTransport({ kind: "library" });
  await transport.sendMessages({
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }], metadata: {} }],
    trigger: "submit-message",
  } as never);
  expect(sentBookId).toBeNull();
});
```

> 具体 mock 形态以文件现有写法为准；关键断言：library 路径不抛、`bookId` 发出为 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/ipc-chat-transport.test.ts -t "library context"`
Expected: FAIL — `createIpcChatTransport` 不接受参数；现实现读 `currentBookId` 且 `!currentBookId` 时抛错。

- [ ] **Step 3: 改实现** — `createIpcChatTransport(context: ChatContext)`，按 context 分流 bookId / 会话槽 / 懒建：

顶部 import：`import { type ChatContext } from "@renderer/ai/chat-context";`。

```ts
export function createIpcChatTransport(context: ChatContext): ChatTransport<ChatUIMessage> {
  const bookId = context.kind === "book" ? context.bookId : null;
  return {
    async sendMessages({ messages, abortSignal, trigger }) {
      const readingContext =
        context.kind === "book" ? useNavigationStore.getState().readingContext : null;
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      if (trigger === "regenerate-message") {
        const conversationId = getActiveConversationId(context);
        if (!conversationId || !last) {
          void stream.cancel();
          const { default: i18n } = await import("@renderer/i18n");
          throw new Error(i18n.t("ai.cannotResend", "无法重发：找不到会话或目标消息"));
        }
        const ack = await window.api.ai.resend({
          streamId,
          conversationId,
          userMessageId: last.id,
          userText,
        });
        if (!ack.ok) {
          void stream.cancel();
          throw new Error(ack.reason);
        }
        return stream;
      }

      let conversationId = getActiveConversationId(context);
      if (!conversationId) {
        const convo = await window.api.chat.conversations.create({ bookId });
        useChatStore.getState().setActiveConversation(context, convo.id);
        conversationId = convo.id;
      }
      const chips = (last?.metadata?.contextChips ?? []).filter((c) => c.state !== "off");
      const ack = await window.api.ai.send({
        streamId,
        bookId,
        conversationId,
        chips,
        userText,
        readingContext,
      });
      if (!ack.ok) {
        void stream.cancel();
        throw new Error(ack.reason);
      }
      return stream;
    },
    reconnectToStream: async () => null,
  };
}
```

> 删掉原 `!currentBookId` 抛错分支（library 是合法无书态）；`getActiveConversationId`/`setActiveConversation` 均传 `context`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/ipc-chat-transport.test.ts`
Expected: PASS（含原有 book 用例——可能需把它们的 `createIpcChatTransport()` 调用改成 `createIpcChatTransport({ kind: "book", bookId: "..." })` 并设好 nav）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ai/ipc-chat-transport.ts src/renderer/ai/ipc-chat-transport.test.ts
git commit -m "feat(renderer): parameterize chat transport by context (book | library)"
```

---

### Task 11: `AIPanel` 收 `context` + `onClose`

**Files:**

- Modify: `src/renderer/ai/AIPanel.tsx`

- [ ] **Step 1: 改 props 与内部读取** — `AIPanel` 改签名并把所有「书相关」读取改走 context：

```tsx
import { type ChatContext } from "@renderer/ai/chat-context";
// ...
export function AIPanel({ context, onClose }: { context: ChatContext; onClose: () => void }) {
  // useChat transport 绑定 context
  const { messages, sendMessage, status, stop, setMessages, regenerate, error } =
    useChat<ChatUIMessage>({
      transport: createIpcChatTransport(context),
      onError: (err) => log.warn("chat stream error", err),
    });
  // ...
  const activeConversationId = useActiveConversationId(context);
  const bookId = context.kind === "book" ? context.bookId : null;
  const convosQuery = useQuery(conversationsQuery(context));
  // ...
```

要点：

- 删除 `const bookId = useNavigationStore((s) => s.currentBookId);`，改为上面从 context 派生。
- `convosQuery` 去掉 `enabled: !!bookId`（library 也要列）。
- `newConversation`：

```tsx
const newConversation = async () => {
  try {
    const convo = await window.api.chat.conversations.create({
      bookId: context.kind === "book" ? context.bookId : null,
    });
    setMessages([]);
    useChatStore.getState().setActiveConversation(context, convo.id);
    useChatStore.getState().setSummaryChipsPreset();
    openPanelAndFocusComposer();
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  } catch (err) {
    log.warn("create conversation failed", err);
  }
};
```

- 关闭按钮 `onClick` 由 `() => updateLayout({ panelOpen: false })` 改为 `onClose`（删除对 `usePrefsStore` updateLayout 的依赖，若 layout 仅此处用）。
- `MessageList` 的 `bookId={bookId}` 保持（其 prop 已是 `string | null`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: AIPanel 本身无错；报错转移到其两个调用点（ReaderView / 新 FloatingAssistant）——下两个 task 修。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/ai/AIPanel.tsx
git commit -m "feat(renderer): drive AIPanel by injected ChatContext + onClose"
```

---

### Task 12: `ConversationsTab` 收 context + `Sidebar` 透传

**Files:**

- Modify: `src/renderer/reader/ConversationsTab.tsx`
- Modify: `src/renderer/reader/Sidebar.tsx:70`

- [ ] **Step 1: 改 `ConversationsTab`** — 由 `{ bookId: string }` 改为 `{ context: ChatContext }`：

```tsx
import { type ChatContext, contextKey } from "@renderer/ai/chat-context";

export function ConversationsTab({ context }: { context: ChatContext }) {
  // ...
  const activeId = useActiveConversationId(context);          // 替换 s.activeByBook[bookId]
  const openConversation = useChatStore((s) => s.openConversation);
  const convos = useQuery(conversationsQuery(context));       // 替换 conversationsQuery(bookId)
  const key = contextKey(context);
  // ...
```

改动点：

- `useChatStore((s) => s.activeByBook[bookId] ?? null)` → `useActiveConversationId(context)`（顶部 import 它）。
- `onOpen={() => openConversation(c.id)}` → `onOpen={() => openConversation(context, c.id)}`。
- deleteConvo 成功回调里：`getActiveConversationId()` → `getActiveConversationId(context)`；`s.setActiveConversation(null)` → `s.setActiveConversation(context, null)`；两处 `qk.conversations(bookId)` → `qk.conversations(key)`。

- [ ] **Step 2: 改 `Sidebar.tsx`** — 第 70 行 `<ConversationsTab bookId={bookId} />` → `<ConversationsTab context={{ kind: "book", bookId }} />`（Sidebar 仍是阅读器内、恒 book 上下文）。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 这两个文件无错。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/reader/ConversationsTab.tsx src/renderer/reader/Sidebar.tsx
git commit -m "feat(renderer): make ConversationsTab context-aware"
```

---

### Task 13: `ReaderView` 传 book context 给 `AIPanel`

**Files:**

- Modify: `src/renderer/reader/ReaderView.tsx:282`

- [ ] **Step 1: 改 mount** — 读 `ReaderView.tsx` 上下文，拿到当前 `bookId`（该组件已有 currentBookId/book）。把 `<AIPanel />` 改为：

```tsx
<AIPanel context={{ kind: "book", bookId }} onClose={() => updateLayout({ panelOpen: false })} />
```

其中 `bookId` 用 ReaderView 内既有的当前书 id 变量；`updateLayout` 从 `usePrefsStore` 取（ReaderView 控制停靠面板开合，此前由 AIPanel 内部调，现上提到容器）。若 ReaderView 尚未引入 `updateLayout`，加 `const updateLayout = usePrefsStore((s) => s.updateLayout);`。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: ReaderView 无错；仅剩 AppShell/FloatingAssistant（未建）相关。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/reader/ReaderView.tsx
git commit -m "feat(renderer): pass book context + onClose to docked AIPanel"
```

---

### Task 14: `FloatingAssistant` 悬浮容器 + `AppShell` 挂载

**Files:**

- Create: `src/renderer/ai/FloatingAssistant.tsx`
- Modify: `src/renderer/shell/AppShell.tsx`
- Modify: `src/shared/i18n/locales/en.ts` + `zh-CN.ts`（经 extract）

- [ ] **Step 1: 实现 `FloatingAssistant.tsx`**

```tsx
// src/renderer/ai/FloatingAssistant.tsx —— 书库/统计视图的全局悬浮助手（spec 2026-06-16 §5.4）。
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { AIPanel } from "@renderer/ai/AIPanel";

const LIBRARY_CONTEXT = { kind: "library" } as const;

export function FloatingAssistant() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={t("ai.openLibraryAssistant", "问问 Lia")}
        className="fixed bottom-6 end-6 z-40 size-12 rounded-full shadow-lg"
      >
        <MessageCircle />
      </Button>
    );
  }

  return (
    <div className="fixed bottom-6 end-6 z-40 flex h-[600px] max-h-[80vh] w-96 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
      <AIPanel context={LIBRARY_CONTEXT} onClose={() => setOpen(false)} />
    </div>
  );
}
```

> 拖拽/缩放后续打磨（spec §5.4）。`AIPanel` 自带 header（含 +新对话、关闭 X→onClose）与 Composer，浮层只提供定位外壳。

- [ ] **Step 2: 挂到 `AppShell`** — `src/renderer/shell/AppShell.tsx`：

```tsx
import { useNavigationStore } from "@renderer/store/navigation-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { StatsView } from "@renderer/stats/StatsView";
import { ShellHeader } from "@renderer/shell/ShellHeader";
import { FloatingAssistant } from "@renderer/ai/FloatingAssistant";

export function AppShell() {
  const view = useNavigationStore((s) => s.view);
  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <ShellHeader />
      <div className="min-h-0 flex-1">{view === "stats" ? <StatsView /> : <LibraryView />}</div>
      <FloatingAssistant />
    </div>
  );
}
```

> `AppShell` 只在非阅读器视图渲染（App.tsx 按 view 路由），故悬浮助手天然只现身 library/stats，与阅读器停靠面板不重叠（spec §5.4）。

- [ ] **Step 3: 抽取 i18n key**

Run: `pnpm i18n:extract`
Expected: `ai.openLibraryAssistant` 进入主语言；按需在 `zh-CN.ts`/`en.ts` 填好两语言文案（中文「问问 Lia」、英文 "Ask Lia"）。

- [ ] **Step 4: 全量类型检查 + 测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。若 typecheck 报渲染层残留（旧 `setActiveConversation`/`openConversation` 调用点未带 context），逐一补 context 修到绿。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ai/FloatingAssistant.tsx src/renderer/shell/AppShell.tsx src/shared/i18n/locales
git commit -m "feat(renderer): add floating library assistant in app shell"
```

---

### Task 15: 收尾——全量校验 + changeset + 冒烟

**Files:**

- Create: `.changeset/<random>.md`

- [ ] **Step 1: 全量校验**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: 全绿。任何失败就地修复后重跑。

- [ ] **Step 2: i18n 校验**

Run: `pnpm i18n:lint`
Expected: 无缺漏 key（新增的 librarian 文案两语言齐备）。

- [ ] **Step 3: 写 changeset**

Run: `pnpm changeset`（交互式；或直接创建 `.changeset/library-ai-companion.md`）：

```md
---
"marginalia": minor
---

Add a library AI companion: ask Lia from the library via a floating assistant. She can browse your whole collection, your notes/highlights, and reading stats to discuss your shelf and recommend what to read next — grounded in her memory of you.
```

```bash
git add .changeset
git commit -m "chore: changeset for library AI companion"
```

- [ ] **Step 4: 手动冒烟（需已配置 AI 模型）**

启动 `pnpm start`（或对产物用 `--user-data-dir=/tmp/lia-smoke` 冒烟，避免污染真实 userData）：

1. 在书库视图右下点悬浮按钮 → 浮层打开，显示 Lia 面板。
2. 问「我接下来该读哪本？」→ 断言 Lia 调了书库工具（DevTools/日志可见 tool step）并给出基于库内书的推荐。
3. 进入某本书阅读 → 阅读器停靠面板仍工作（book 上下文未回归），其会话与书库会话互不串台。
4. 回书库 → 浮层仍是书库会话（context 随视图切换）。

记录冒烟结果（通过/问题）。CDP 自动化冒烟可选（见 memory `playwright-cdp-smoke`），但需配模型。

---

## Self-Review（plan 对 spec 核对）

- **§2 ChatContext 脊柱** → Task 7（渲染层基元）+ Task 6（主进程按 bookId 分流）✅
- **§3 数据模型/迁移** → Task 1 ✅
- **§4.1 契约** → Task 2 ✅
- **§4.2 会话仓库** → Task 3（含 `listConversationsByBook` 泛化、不另起函数）✅
- **§4.3 发送管线 + librarian prompt** → Task 5 + Task 6 ✅
- **§4.4 书库工具** → Task 4 + Task 4b ✅
- **§5.1 context 注入 AIPanel** → Task 11 ✅
- **§5.2 chat-store 保 activeByBook + 加标量** → Task 8 ✅
- **§5.3 跨视图连续性** → 由 Task 8 的 context-keyed 槽 + Task 7 派生自然得到 ✅
- **§5.4 悬浮容器** → Task 14 ✅
- **§5.5 会话列表泛化** → Task 12（ConversationsTab 收 context）+ Task 9（query 收 context）✅
- **§5.6 transport** → Task 10 ✅
- **§6 错误处理** → 沿用既有纪律：工具 `{error}`（Task 4 runTool 复用）、模型未配置 banner（AIPanel 既有 error 区，未动）、空库 listBooks 返回 `[]`（Task 4）、noBookToSend 仅 library 豁免（Task 10 删该分支）✅
- **§7 测试** → 各 task 内置 TDD；Task 15 全量 + 冒烟 ✅
- **§8 不做** → 未加跨库读正文 / 联网 / 新 agent / 阅读器内悬浮 / 拖拽缩放 ✅

**类型一致性核对**：`ChatContext`、`contextKey`、`deriveChatContext`（Task 7）在 Task 8/9/10/11/12/13/14 一致引用；`buildSystemPrompt(db, conversationId, kind)` 第三参在 Task 5 定义、Task 6 调用一致；`createLibraryTools({ db })`（Task 4）在 Task 6 调用一致；`setActiveConversation(ctx, id)` / `getActiveConversationId(ctx)` / `openConversation(ctx, id)` 新签名在 Task 8 定义、Task 10/11/12 一致使用。
