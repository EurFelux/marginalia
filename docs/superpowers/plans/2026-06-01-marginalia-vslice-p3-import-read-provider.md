# 竖切 Plan 3：S2 导入+读正文 · S-prov Anthropic 设置 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已打通的渲染层地基（S1）上落地两条独立切面——S2「导入样例 ePub → 读到真实章节正文」与 S-prov「仅 Anthropic 的 Provider/默认 Assistant 设置」，使 `resolveModel` 能解出真模型（为 Plan 4 的 S3/S4 端到端铺路）。

**Architecture:** 主进程厚 / 渲染层薄硬性规则不变。S2/S-prov 复用 MA2/MA3 既有业务函数与 Plan 1 已接线的 `window.api`（library/content/settings 全就绪）。研究发现 spec 未顾到两处必要缺口，本计划补两个最小主进程补口：(1) `content.chapters(bookId)`——渲染层需要 chapter 的 surrogate `id`（`content.toc` 只给 `href`，`content.chapterText` 却按 `chapters.id` 查），(2) `library.pickEpub()`——渲染层不能直接开原生文件框，需主进程 `dialog.showOpenDialog`。两者均属 spec §5「按需后续补」。渲染层组件移植 UP1 的排版外壳、替换数据源为 `window.api` + TanStack Query + zustand。

**Tech Stack:** Electron 41（已锁定）+ React 19 + TanStack Query 5 + zustand 5 + Tailwind 4 + better-sqlite3（Node ABI 测试 / Electron ABI 运行）+ vitest 4 + Zod 4。

**ABI 提示（执行者必读）：** 本计划的 vitest 测试需 **Node ABI**（直接 `pnpm test`）。**不要**在执行 TDD 任务期间跑 `pnpm start`（会把 better-sqlite3 切成 Electron ABI 致测试 ABI 不匹配）。`pnpm start` 仅在标注的**手测检查点**由人执行；手测后须 `pnpm db:rebuild:node` 才能继续跑测试。

---

## 文件结构

**主进程补口（Part A，headless TDD）：**

| 文件                               | 责任                    | 改动                                                      |
| ---------------------------------- | ----------------------- | --------------------------------------------------------- |
| `src/shared/ipc.ts`                | IPC 通道名              | 新增 `contentChapters`、`libraryPickEpub`                 |
| `src/shared/library.ts`            | library 领域 schema/DTO | 新增 `ChapterRefDto`                                      |
| `src/main/library/content.ts`      | 内容业务纯函数          | 新增 `listChapters(db, bookId)`                           |
| `src/main/library/content.test.ts` | headless 测试           | 新增 `listChapters` 用例                                  |
| `src/main/ipc/library-handlers.ts` | Electron 胶水层         | 新增 `content:chapters`、`library:pick-epub` 两个 handler |
| `src/preload.ts`                   | typed `window.api`      | `content.chapters`、`library.pickEpub`                    |
| `src/renderer/query/keys.ts`       | 查询键工厂              | 新增 `qk.chapters`                                        |
| `src/renderer/query/keys.test.ts`  | headless 测试           | 新增 `qk.chapters` 用例                                   |

**渲染层（Part B/C，typecheck+lint，手测检查点）：**

| 文件                                      | 责任                                            |
| ----------------------------------------- | ----------------------------------------------- |
| `src/renderer/store/reader-store.ts`      | `openBook` 第二参改可选（+ test）               |
| `src/renderer/library/LibraryView.tsx`    | 书库列表 + 导入按钮（S2 第一步）                |
| `src/renderer/reader/ReaderPane.tsx`      | 章节正文静态渲染（按 `\n` 切段 + 偏好内联样式） |
| `src/renderer/reader/ChapterList.tsx`     | 章节导航侧栏                                    |
| `src/renderer/reader/ReaderPrefs.tsx`     | 阅读偏好浮层（字号/行距/栏宽）                  |
| `src/renderer/reader/ReaderView.tsx`      | reader 三块布局 + 首章解析                      |
| `src/renderer/App.tsx`                    | library ↔ reader 视图切换（替换最小桩）         |
| `src/renderer/settings/SettingsPanel.tsx` | Anthropic 设置面板（S-prov）                    |

---

## Part A — S2 主进程契约补口

### Task 1: `content.chapters` 契约（渲染层取 chapter id 的真源）

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/library.ts`
- Modify: `src/main/library/content.ts`
- Test: `src/main/library/content.test.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/query/keys.ts`
- Test: `src/renderer/query/keys.test.ts`

- [ ] **Step 1: 写失败测试（listChapters 业务函数）**

在 `src/main/library/content.test.ts` 的 `describe("content service", ...)` 内追加（顶部 import 增加 `listChapters`）：

```ts
// 顶部 import 改为：
import { getChapterSummary, getToc, listChapters, readChapterText } from "@main/library/content";
```

```ts
it("listChapters returns chapters ordered by orderIndex with id/title/href", () => {
  const { db, book } = setup();
  const chs = listChapters(db, book.id);
  expect(chs.map((c) => c.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
  expect(chs.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
  expect(chs.map((c) => c.orderIndex)).toEqual([0, 1]);
  expect(chs.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/content.test.ts`
Expected: FAIL（`listChapters` is not exported / not a function）。

- [ ] **Step 3: 加 `ChapterRefDto` 到 shared**

在 `src/shared/library.ts` 末尾追加：

```ts
/** 章节导航引用：渲染层据此列章 / 取 surrogate id 喂 content.chapterText。 */
export interface ChapterRefDto {
  id: string;
  title: string | null;
  href: string;
  orderIndex: number;
}
```

- [ ] **Step 4: 实现 `listChapters`**

`src/main/library/content.ts`：import 增加 `asc`，并 import `ChapterRefDto`：

```ts
import { and, asc, eq } from "drizzle-orm";
import type { ChapterRefDto, ChapterTextSlice } from "@shared/library";
```

文件末尾追加：

```ts
/** 按 spine 顺序（orderIndex）列出某书全部章节引用。title 可能为 null（TOC 无对应 label 时）。 */
export function listChapters(db: DB, bookId: string): ChapterRefDto[] {
  return db
    .select({
      id: chapters.id,
      title: chapters.title,
      href: chapters.href,
      orderIndex: chapters.orderIndex,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all()
    .map((c) => ({ id: c.id, title: c.title, href: c.href, orderIndex: c.orderIndex ?? 0 }));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/library/content.test.ts`
Expected: PASS（含新用例）。

- [ ] **Step 6: 加 IPC 通道名**

`src/shared/ipc.ts` 的 `IPC` 对象内，`contentChapterSummary` 行后追加：

```ts
  contentChapters: "content:chapters",
```

并在 `libraryGet` 行后追加（pick-epub 通道，Task 2 用，提前加避免二次改文件）：

```ts
  libraryPickEpub: "library:pick-epub",
```

- [ ] **Step 7: 加 handler**

`src/main/ipc/library-handlers.ts`：import 增加 `listChapters` 与 `ChapterRefDto`：

```ts
import {
  getChapterSummary,
  getToc,
  listChapters,
  readChapterText,
  type ChapterSummary,
} from "@main/library/content";
```

```ts
import {
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  type BookSummaryDto,
  type ChapterRefDto,
  type ChapterTextSlice,
} from "@shared/library";
```

在 `registerLibraryHandlers()` 内、`contentToc` handler 后追加：

```ts
handle<{ bookId: string }, ChapterRefDto[]>(IPC.contentChapters, bookIdInput, (input) => {
  const db = getDb();
  if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
  return listChapters(db, input.bookId);
});
```

- [ ] **Step 8: preload 暴露 `content.chapters`**

`src/preload.ts`：import 增加 `ChapterRefDto`：

```ts
import type {
  BookIdInput,
  BookSummaryDto,
  ChapterRefDto,
  ChapterTextSlice,
  ImportBookInput,
  ReadChapterTextInput,
} from "@shared/library";
```

`content` 分组内 `toc` 后追加：

```ts
    chapters: (input: BookIdInput): Promise<ChapterRefDto[]> =>
      ipcRenderer.invoke(IPC.contentChapters, input),
```

- [ ] **Step 9: 写失败测试（qk.chapters）**

`src/renderer/query/keys.test.ts` 的 `parametric keys` 用例内追加一行断言：

```ts
expect(qk.chapters("b1")).toEqual(["chapters", "b1"]);
```

- [ ] **Step 10: 跑测试确认失败**

Run: `pnpm test src/renderer/query/keys.test.ts`
Expected: FAIL（`qk.chapters` is not a function）。

- [ ] **Step 11: 加 `qk.chapters`**

`src/renderer/query/keys.ts` 的 `toc` 行后追加：

```ts
  chapters: (bookId: string) => ["chapters", bookId] as const,
```

- [ ] **Step 12: 跑全量测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全 PASS，无类型错误。

- [ ] **Step 13: Commit**

```bash
git add src/shared/ipc.ts src/shared/library.ts src/main/library/content.ts src/main/library/content.test.ts src/main/ipc/library-handlers.ts src/preload.ts src/renderer/query/keys.ts src/renderer/query/keys.test.ts
git commit -m "feat(content): add content.chapters IPC for renderer chapter navigation"
```

---

### Task 2: `library.pickEpub` 原生文件选择器

**Files:**

- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/preload.ts`

> 通道名 `libraryPickEpub` 已在 Task 1 Step 6 加入。本 handler 触碰 Electron `dialog`，属胶水层，不做 headless 单测（手测检查点覆盖）。

- [ ] **Step 1: 加 dialog handler**

`src/main/ipc/library-handlers.ts` 顶部 import 增加 electron：

```ts
import { BrowserWindow, dialog } from "electron";
```

在 `registerLibraryHandlers()` 内、`libraryImport` handler 后追加：

```ts
handle<void, string | null>(IPC.libraryPickEpub, z.void(), async () => {
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    properties: ["openFile" as const],
    filters: [{ name: "EPUB", extensions: ["epub"] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});
```

- [ ] **Step 2: preload 暴露 `library.pickEpub`**

`src/preload.ts` 的 `library` 分组内 `import` 方法后追加：

```ts
    pickEpub: (): Promise<string | null> => ipcRenderer.invoke(IPC.libraryPickEpub),
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/library-handlers.ts src/preload.ts
git commit -m "feat(library): add library.pickEpub native file dialog handler"
```

---

## Part B — S2 渲染层

### Task 3: `reader-store.openBook` 第二参改可选

**Files:**

- Modify: `src/renderer/store/reader-store.ts`
- Test: `src/renderer/store/reader-store.test.ts`

> LibraryView 点书时尚不知首章 id（需异步取 `content.chapters`），故 `openBook` 支持只传 `bookId`、`currentChapterId` 置 null，由 ReaderView 加载章节列表后回填首章。第二参改可选保旧测试（`openBook("b1","c1")`）不破。

- [ ] **Step 1: 写失败测试（openBook 单参）**

`src/renderer/store/reader-store.test.ts` 的 `describe` 内追加：

```ts
it("openBook with only bookId leaves currentChapterId null", () => {
  useReaderStore.getState().openBook("b1");
  const s = useReaderStore.getState();
  expect(s.view).toBe("reader");
  expect(s.currentBookId).toBe("b1");
  expect(s.currentChapterId).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/reader-store.test.ts`
Expected: FAIL（当前 `openBook` 要求两参；单参调用 `currentChapterId` 变 `undefined` 而非 `null`，断言失败）。

- [ ] **Step 3: 改 `openBook` 签名与实现**

`src/renderer/store/reader-store.ts`：

接口里把

```ts
  openBook: (bookId: string, chapterId: string) => void;
```

改为

```ts
  openBook: (bookId: string, chapterId?: string | null) => void;
```

实现里把

```ts
  openBook: (currentBookId, currentChapterId) =>
    set({ view: "reader", currentBookId, currentChapterId, activeConversationId: null }),
```

改为

```ts
  openBook: (bookId, chapterId = null) =>
    set({
      view: "reader",
      currentBookId: bookId,
      currentChapterId: chapterId,
      activeConversationId: null,
    }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/reader-store.test.ts`
Expected: PASS（新旧用例均过）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts
git commit -m "feat(reader-store): make openBook chapterId optional for deferred first-chapter resolution"
```

---

### Task 4: `LibraryView`（书库列表 + 导入按钮）

**Files:**

- Create: `src/renderer/library/LibraryView.tsx`

> 纯展示型组件，无 headless 单测（spec §9：组件交互不强求 headless）。验收靠 typecheck/lint + Task 8 后手测。

- [ ] **Step 1: 写组件**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FolderOpen, Settings } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";

export function LibraryView() {
  const qc = useQueryClient();
  const openBook = useReaderStore((s) => s.openBook);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const books = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });

  const importBook = useMutation({
    mutationFn: async () => {
      const filePath = await window.api.library.pickEpub();
      if (!filePath) return null;
      return window.api.library.import({ filePath });
    },
    onSuccess: (book) => {
      if (book) void qc.invalidateQueries({ queryKey: qk.library });
    },
  });

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => importBook.mutate()}
            disabled={importBook.isPending}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <FolderOpen className="size-4" />
            {importBook.isPending ? "导入中…" : "导入 ePub"}
          </button>
          <button
            onClick={() => openSettings(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            aria-label="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {importBook.isError && (
          <p className="mb-4 text-sm text-destructive">
            导入失败：{(importBook.error as Error).message}
          </p>
        )}
        {books.isPending && <p className="text-sm text-muted-foreground">加载书库…</p>}
        {books.isError && <p className="text-sm text-destructive">读取书库失败</p>}
        {books.data?.length === 0 && (
          <div className="mt-20 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
            <p className="text-sm">书库为空，点右上角「导入 ePub」开始。</p>
          </div>
        )}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {books.data?.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => openBook(b.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-3 text-left hover:bg-muted"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{b.title ?? b.id}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {b.author ?? "未知作者"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误（组件未被引用前 typecheck 仍会编译该文件）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/library/LibraryView.tsx
git commit -m "feat(renderer): add LibraryView with import button and book grid"
```

---

### Task 5: `ReaderPane`（章节正文静态渲染）

**Files:**

- Create: `src/renderer/reader/ReaderPane.tsx`

> 正文按 `ChapterTextSlice.text` 的 `\n` 切段渲染（块级换行）。`maxWidth`/`fontSize`/`lineHeight` 是随用户偏好的运行时计算值——按 CLAUDE.md 代码规范，**这类值允许内联 `style`**。本切片仅渲染首个 slice（默认 ≤20k 字，足够「读某章」MVP）；`hasMore` 时给提示，章内完整分页留后续。

- [ ] **Step 1: 写组件**

```tsx
import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

interface Props {
  bookId: string;
  chapterId: string;
  title: string | null;
}

export function ReaderPane({ bookId, chapterId, title }: Props) {
  const prefs = useReaderStore((s) => s.prefs);
  const chapter = useQuery({
    queryKey: qk.chapter(bookId, chapterId),
    queryFn: () => window.api.content.chapterText({ bookId, chapterId }),
  });

  const paragraphs = (chapter.data?.text ?? "").split("\n").filter((p) => p.trim().length > 0);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <article
        className="mx-auto px-10 py-14 font-serif text-foreground/90"
        style={{
          maxWidth: prefs.maxWidth,
          fontSize: `${1.125 * prefs.fontScale}rem`,
          lineHeight: prefs.lineHeight,
        }}
      >
        {title && (
          <h2 className="mb-8 font-sans text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {title}
          </h2>
        )}
        {chapter.isPending && <p className="text-sm text-muted-foreground">加载正文…</p>}
        {chapter.isError && (
          <p className="text-sm text-destructive">
            章节读取失败：{(chapter.error as Error).message}
          </p>
        )}
        {chapter.data && paragraphs.length === 0 && (
          <p className="text-sm text-muted-foreground">（本章无正文）</p>
        )}
        {paragraphs.map((p, i) => (
          <p key={i} className="mb-6 text-justify">
            {p}
          </p>
        ))}
        {chapter.data?.hasMore && (
          <p className="mt-10 text-center font-sans text-xs text-muted-foreground">
            （本章较长，已显示前 {chapter.data.text.length} 字；章内完整分页见后续里程碑）
          </p>
        )}
      </article>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/ReaderPane.tsx
git commit -m "feat(renderer): add ReaderPane rendering chapter text as paragraphs"
```

---

### Task 6: `ChapterList`（章节导航侧栏）

**Files:**

- Create: `src/renderer/reader/ChapterList.tsx`

- [ ] **Step 1: 写组件**

```tsx
import { useQuery } from "@tanstack/react-query";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

export function ChapterList({ bookId }: { bookId: string }) {
  const currentChapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });

  return (
    <nav className="flex h-full flex-col gap-0.5 overflow-y-auto p-2 font-sans">
      {chapters.isPending && <p className="p-2 text-sm text-muted-foreground">加载目录…</p>}
      {chapters.isError && <p className="p-2 text-sm text-destructive">目录读取失败</p>}
      {chapters.data?.map((ch) => (
        <button
          key={ch.id}
          onClick={() => setCurrentChapter(ch.id)}
          className={cn(
            "truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            ch.id === currentChapterId
              ? "bg-primary/10 font-medium text-primary"
              : "text-foreground/80 hover:bg-muted",
          )}
        >
          {ch.title ?? `第 ${ch.orderIndex + 1} 章`}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/ChapterList.tsx
git commit -m "feat(renderer): add ChapterList navigation sidebar"
```

---

### Task 7: `ReaderPrefs`（阅读偏好浮层）

**Files:**

- Create: `src/renderer/reader/ReaderPrefs.tsx`

> 移植 UP1 SettingsPopover 的三行 ±调节，写入 reader-store `updatePrefs`。范围/步进：fontScale 0.8–1.5 step 0.05；lineHeight 1.4–2.4 step 0.1；maxWidth 480–820 step 40。

- [ ] **Step 1: 写组件**

```tsx
import { useState } from "react";
import { Minus, Plus, Type } from "lucide-react";
import { useReaderStore } from "@renderer/store/reader-store";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

function Row({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
        <button
          onClick={onDec}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={`减小${label}`}
        >
          <Minus className="size-3" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{value}</span>
        <button
          onClick={onInc}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={`增大${label}`}
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
}

export function ReaderPrefs() {
  const prefs = useReaderStore((s) => s.prefs);
  const updatePrefs = useReaderStore((s) => s.updatePrefs);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-2 text-muted-foreground hover:bg-muted"
        aria-label="阅读偏好"
      >
        <Type className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-60 space-y-2 rounded-xl border border-border bg-popover p-3 shadow-xl">
          <Row
            label="字号"
            value={`${Math.round(prefs.fontScale * 100)}%`}
            onDec={() =>
              updatePrefs({ fontScale: round2(clamp(prefs.fontScale - 0.05, 0.8, 1.5)) })
            }
            onInc={() =>
              updatePrefs({ fontScale: round2(clamp(prefs.fontScale + 0.05, 0.8, 1.5)) })
            }
          />
          <Row
            label="行距"
            value={prefs.lineHeight.toFixed(1)}
            onDec={() =>
              updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight - 0.1, 1.4, 2.4)) })
            }
            onInc={() =>
              updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight + 0.1, 1.4, 2.4)) })
            }
          />
          <Row
            label="栏宽"
            value={`${prefs.maxWidth}px`}
            onDec={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth - 40, 480, 820) })}
            onInc={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth + 40, 480, 820) })}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/ReaderPrefs.tsx
git commit -m "feat(renderer): add ReaderPrefs popover for font/line/width"
```

---

### Task 8: `ReaderView` + `App.tsx` 视图切换（S2 收口）

**Files:**

- Create: `src/renderer/reader/ReaderView.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 写 `ReaderView`（组合 ChapterList + ReaderPane + chrome，解析首章）**

```tsx
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Settings } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { ChapterList } from "@renderer/reader/ChapterList";
import { ReaderPane } from "@renderer/reader/ReaderPane";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";

export function ReaderView() {
  const bookId = useReaderStore((s) => s.currentBookId);
  const chapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);
  const backToLibrary = useReaderStore((s) => s.backToLibrary);
  const openSettings = useSettingsStore((s) => s.setOpen);

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 首章解析：开书时 currentChapterId 为 null，章节列表到位后回填首章。
  useEffect(() => {
    if (chapterId == null && chapters.data && chapters.data.length > 0) {
      setCurrentChapter(chapters.data[0].id);
    }
  }, [chapterId, chapters.data, setCurrentChapter]);

  if (!bookId) return null;

  const currentTitle = chapters.data?.find((c) => c.id === chapterId)?.title ?? null;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <button
          onClick={backToLibrary}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
          书库
        </button>
        <div className="flex items-center gap-1">
          <ReaderPrefs />
          <button
            onClick={() => openSettings(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            aria-label="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-border bg-muted/30">
          <ChapterList bookId={bookId} />
        </aside>
        <main className="min-w-0 flex-1">
          {chapterId ? (
            <ReaderPane bookId={bookId} chapterId={chapterId} title={currentTitle} />
          ) : (
            <p className="p-10 text-sm text-muted-foreground">
              {chapters.isPending ? "加载章节…" : "本书无可读章节。"}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 替换 `App.tsx` 为视图切换（`SettingsPanel` 暂用占位）**

`SettingsPanel` 在 Task 9 才创建。本任务在它之前，故先用内联占位保证可编译；Task 9 Step 2 会把占位替换为真实 import。`src/renderer/App.tsx` 整体替换为：

```tsx
import { useReaderStore } from "@renderer/store/reader-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";

// 临时占位——Task 9 完成后改回 `import { SettingsPanel } from "@renderer/settings/SettingsPanel";`
const SettingsPanel = () => null;

export function App() {
  const view = useReaderStore((s) => s.view);
  return (
    <>
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsPanel />
    </>
  );
}
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。（设置齿轮此刻是 no-op——`SettingsPanel` 为占位；S2 手测不涉及设置，可接受。）

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/ReaderView.tsx src/renderer/App.tsx
git commit -m "feat(renderer): wire library/reader view switching with ReaderView"
```

- [ ] **Step 5: 【手测检查点 · S2】**

> ⚠️ 由人执行。subagent 在此停下并提示。

```bash
pnpm start
```

验收（spec §7.2 S2）：

- 启动见**书库视图**，右上「导入 ePub」按钮。
- 点「导入 ePub」→ 弹原生文件框 → 选一本 `.epub` → 书出现在书库网格。
- 点书 → 进**阅读视图**：左栏章节列表、主栏渲染该书首章真实正文（衬线、段落分明）。
- 点左栏其他章 → 主栏切到该章正文。
- 「书库」按钮回到书库；字号/行距/栏宽浮层调节即时生效。

手测后若要继续跑测试：`pnpm db:rebuild:node`。

---

## Part C — S-prov Anthropic 设置

### Task 9: `SettingsPanel`（Anthropic：apiKey + model → upsert → test → 设默认）

**Files:**

- Create: `src/renderer/settings/SettingsPanel.tsx`

> 仅 Anthropic 单一类型（spec 决策 #6）。流程：填 apiKey + model → 「保存」`providers.upsert({type:"anthropic", apiKey})` + `assistant.update({providerId, model})`（一次完成「建 provider + 设默认」）→ 「测试连接」`providers.test({id, model})`。`upsertProviderInput` 语义：`apiKey` 省略=保留旧密钥、非空串=替换；不支持清空。`model` 默认填一个 Anthropic 模型，用户可改。

- [ ] **Step 1: 写组件**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { useSettingsStore } from "@renderer/store/settings-store";

export function SettingsPanel() {
  const open = useSettingsStore((s) => s.open);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const testResult = useSettingsStore((s) => s.testResult);
  const setTestResult = useSettingsStore((s) => s.setTestResult);
  const qc = useQueryClient();

  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
    enabled: open,
  });
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
    enabled: open,
  });

  const anthropic = providers.data?.find((p) => p.type === "anthropic") ?? null;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-3-5-haiku-latest");

  const save = useMutation({
    mutationFn: async () => {
      const prov = await window.api.settings.providers.upsert({
        id: anthropic?.id,
        type: "anthropic",
        apiKey: apiKey.trim() || undefined,
      });
      await window.api.settings.assistant.update({ providerId: prov.id, model: model.trim() });
    },
    onSuccess: () => {
      setApiKey("");
      setTestResult(null);
      void qc.invalidateQueries({ queryKey: qk.providers });
      void qc.invalidateQueries({ queryKey: qk.assistantDefault });
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      if (!anthropic) throw new Error("请先保存 provider（填写 API Key 并保存）");
      return window.api.settings.providers.test({ id: anthropic.id, model: model.trim() });
    },
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  if (!open) return null;

  const canSave = apiKey.trim().length > 0 || anthropic != null;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-4">
      <div className="w-[28rem] max-w-full rounded-2xl border border-border bg-card p-5 font-sans text-foreground shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold">设置 · Anthropic</h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              API Key
              {anthropic?.hasKey && (
                <span className="ml-2 text-[11px] text-primary">
                  已配置（{anthropic.keyMask ?? "已加密"}）· 留空保留
                </span>
              )}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={anthropic?.hasKey ? "（保持不变）" : "sk-ant-…"}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">模型</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-3-5-haiku-latest"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>

          {assistant.data && (
            <p className="text-[11px] text-muted-foreground">
              当前默认：provider {assistant.data.providerId ?? "（未设）"} · model{" "}
              {assistant.data.model ?? "（未设）"}
            </p>
          )}

          {save.isError && (
            <p className="text-sm text-destructive">保存失败：{(save.error as Error).message}</p>
          )}
          {testResult && (
            <p
              className={
                testResult.ok
                  ? "flex items-center gap-1.5 text-sm text-primary"
                  : "flex items-center gap-1.5 text-sm text-destructive"
              }
            >
              {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
              {testResult.ok ? "连接成功" : `连接失败：${testResult.message ?? ""}`}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => test.mutate()}
              disabled={test.isPending || !anthropic}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {test.isPending ? "测试中…" : "测试连接"}
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || !canSave}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 还原 `App.tsx` 的真实 import**

删除 Task 8 引入的占位行 `const SettingsPanel = () => null;`，在顶部 import 区恢复真实 import：

```tsx
import { SettingsPanel } from "@renderer/settings/SettingsPanel";
```

- [ ] **Step 3: typecheck + lint + 全量测试**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/SettingsPanel.tsx src/renderer/App.tsx
git commit -m "feat(renderer): add Anthropic SettingsPanel (upsert + test + set default)"
```

---

### Task 10: S-prov 收口手测

**Files:** 无（接线已在 Task 4 / Task 8 的 chrome 里：LibraryView 与 ReaderView 头部均有齿轮 → `useSettingsStore.setOpen(true)`；`SettingsPanel` 已在 App 挂载）。

- [ ] **Step 1: 【手测检查点 · S-prov】**

> ⚠️ 由人执行。

```bash
pnpm start
```

验收（spec §7.2 S-prov）：

- 书库或阅读视图点齿轮 → 设置面板弹出（Anthropic）。
- 填真实 Anthropic API Key + 模型 → 「保存」→ 面板显示「已配置」掩码，无报错。
- 「测试连接」→ 显「连接成功」（或可读失败原因）。
- 重开面板，默认 provider/model 已记住（assistant 持久化）。

> 这一步让 `resolveAssistantModel` 能解出真模型——即 Plan 4 的 `ai:send` 不再返回 `{ok:false}`，是 S4 端到端的前置。手测后跑测试前 `pnpm db:rebuild:node`。

---

## 完成后

全部任务过 + 两个手测检查点通过后：

- 本计划所有 commit 留在分支 `feat/vslice-p1-ipc-transport`、并入 **PR #6**（整个竖切一个 PR）。
- 继续 **Plan 4**（S3 选区→chip→composer + S4 端到端真模型流式）——依赖本计划的 S2 正文渲染（选区源）与 S-prov 的可解析模型。

## 刻意推迟（不在本计划）

- 章内完整分页（`hasMore` 续读 `nextOffset`）——本计划仅渲首 slice。
- 嵌套 TOC（`content.toc` 的层级目录渲染，需 href→id 映射）——本计划用扁平 `content.chapters`，留 RA1-full。
- 封面图、阅读进度（`progress:*`）、会话列表/历史消息渲染——非 S2/S-prov 范围。
- 多 provider 类型、`providers.reveal`「👁 显示明文」、provider 删除 UI。
