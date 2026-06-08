# 书籍「已读完」标记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `books` 加一个手动可切换的 `isFinished` 标记，用户在书库右键菜单标记/取消，封面右上角显示绿色 ✓ 角标。

**Architecture:** 沿用「`@shared` Zod 单一数据源 → 纯函数 repository（注入 DB）→ handlers 胶水层 → preload 自动生成 API → renderer react-query mutation」脊柱。`isFinished` 是 `books` 表独立布尔列，不与 `progress` 耦合。主进程逻辑 headless TDD（vitest + `:memory:`），UI 留 app 冒烟验收。

**Tech Stack:** Drizzle ORM (better-sqlite3)、Zod 4、React 19 + react-query、Base UI ContextMenu、Tailwind、lucide-react、i18next。

设计依据：`docs/superpowers/specs/2026-06-09-book-finished-mark-design.md`。

---

### Task 1: Schema 列 + 迁移

**Files:**

- Modify: `src/main/db/schema.ts`（`books` 表定义，约 61-90 行）
- Generate: `src/main/db/migrations/<timestamp>_*/`（由 `pnpm db:generate` 产出）

- [ ] **Step 1: 给 `books` 加 `isFinished` 列**

在 `parserVersion` 列之后追加：

```ts
    // 「已读完」手动标记（#70）：独立布尔，不从 progress 派生、不影响进度。默认未读完。
    isFinished: integer("is_finished", { mode: "boolean" }).notNull().default(false),
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新建 `src/main/db/migrations/<timestamp>_<name>/`，其 `migration.sql` 为单条 additive ALTER（无表重建）：

```sql
ALTER TABLE `books` ADD `is_finished` integer DEFAULT false NOT NULL;
```

- [ ] **Step 3: 核验迁移内容**

Run: `cat src/main/db/migrations/*/migration.sql | grep is_finished`
Expected: 出现上面那行；**确认没有** `__new_books` 表重建语句（加列应是纯 ALTER）。

- [ ] **Step 4: 跑一次测试确认迁移可应用、未破坏既有**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS（既有用例不受影响；迁移在 `freshDb()` 的 `runMigrations` 中成功应用）。

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(db): add books.is_finished column (#70)"
```

---

### Task 2: Shared 契约（DTO + input + IPC 通道）

**Files:**

- Modify: `src/shared/library.ts`（`BookSummaryDto` 约 43-51 行；新增 input schema）
- Modify: `src/shared/ipc.ts`（import 块约 11-20 行；library 通道块约 117-126 行）
- Test: `src/shared/library.test.ts`

- [ ] **Step 1: 写 `setBookFinishedInput` 的失败测试**

在 `src/shared/library.test.ts` 末尾追加：

```ts
import { setBookFinishedInput } from "@shared/library";

describe("setBookFinishedInput", () => {
  it("accepts valid input", () => {
    const r = setBookFinishedInput.parse({ bookId: "b1", finished: true });
    expect(r).toEqual({ bookId: "b1", finished: true });
    expect(setBookFinishedInput.safeParse({ bookId: "b1", finished: false }).success).toBe(true);
  });

  it("rejects empty bookId", () => {
    expect(setBookFinishedInput.safeParse({ bookId: "", finished: true }).success).toBe(false);
  });

  it("rejects non-boolean / missing finished (not a patch)", () => {
    expect(setBookFinishedInput.safeParse({ bookId: "b1", finished: "yes" }).success).toBe(false);
    expect(setBookFinishedInput.safeParse({ bookId: "b1" }).success).toBe(false);
  });
});
```

注意：`import { setBookFinishedInput }` 与文件顶部既有 `import { updateBookInput } from "@shared/library";` 合并为一行，避免重复 import 语句。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/library.test.ts`
Expected: FAIL（`setBookFinishedInput` 未导出 / undefined）。

- [ ] **Step 3: `BookSummaryDto` 加字段 + 新增 input schema**

`src/shared/library.ts` 的 `BookSummaryDto` 接口加一行：

```ts
export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  hasCover: boolean;
  format: "epub" | "pdf";
  pageCount: number | null;
  hasTextLayer: boolean;
  isFinished: boolean;
}
```

在 `bookIdInput` 之后新增：

```ts
/** #70 「已读完」标记切换。finished 必传（非 patch；缺键拒绝），独立于 progress。 */
export const setBookFinishedInput = z.object({
  bookId: z.string().min(1),
  finished: z.boolean(),
});
export type SetBookFinishedInput = z.infer<typeof setBookFinishedInput>;
```

- [ ] **Step 4: 注册 IPC 通道**

`src/shared/ipc.ts` 的 `from "@shared/library"` 第二个 import 块（含 `bookIdInput`…）加入 `setBookFinishedInput`：

```ts
import {
  bookIdInput,
  // …既有项…
  setBookFinishedInput,
  updateBookInput,
} from "@shared/library";
```

在 `libraryUpdate` 之后新增通道：

```ts
  librarySetFinished: def("library:set-finished", "invoke", setBookFinishedInput, out<BookSummaryDto>()),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/shared/library.test.ts src/shared/ipc.test.ts`
Expected: PASS（新 input 用例通过；漂移测试 `Object.entries(C)` 自动收纳新通道，唯一性/kind 不破）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/library.ts src/shared/ipc.ts src/shared/library.test.ts
git commit -m "feat(shared): add setBookFinished contract + isFinished DTO field (#70)"
```

---

### Task 3: Repository 纯函数（TDD）

**Files:**

- Modify: `src/main/library/repository.ts`（`listBooks` 约 177-191；`listRecentlyRead` 约 197-215；`updateBook` 之后新增 `setBookFinished`）
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

在 `repository.test.ts` 的 `describe("library repository", …)` 内追加用例，并把 `setBookFinished` 加入顶部从 `@main/library/repository` 的 import 列表：

```ts
it("imports a book with isFinished=false by default", async () => {
  const db = freshDb();
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  expect(listBooks(db)[0].isFinished).toBe(false);
  expect(book.isFinished).toBe(false);
});

it("setBookFinished toggles the flag and returns the updated row", async () => {
  const db = freshDb();
  const book = await importBook(db, { bytes: makeFixtureEpub() });

  const marked = setBookFinished(db, book.id, true);
  expect(marked.isFinished).toBe(true);
  expect(listBooks(db)[0].isFinished).toBe(true);

  const unmarked = setBookFinished(db, book.id, false);
  expect(unmarked.isFinished).toBe(false);
  expect(listBooks(db)[0].isFinished).toBe(false);
});

it("setBookFinished throws when the book does not exist", () => {
  const db = freshDb();
  expect(() => setBookFinished(db, "nope", true)).toThrow(/not found/);
});

it("listRecentlyRead projects isFinished", async () => {
  const db = freshDb();
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  saveProgress(db, book.id, "loc-1", 0.5);
  setBookFinished(db, book.id, true);
  expect(listRecentlyRead(db)[0].isFinished).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL（`setBookFinished` 未定义；`listBooks`/`listRecentlyRead` 投影无 `isFinished`）。

- [ ] **Step 3: 实现**

`listBooks` 的 select 对象加一行（在 `hasTextLayer` 后）：

```ts
      hasTextLayer: books.hasTextLayer,
      isFinished: books.isFinished,
```

`listRecentlyRead` 的 select 对象同样在 `hasTextLayer` 后加 `isFinished: books.isFinished,`（位于 `percent`/`lastReadAt` 之前）。

在 `updateBook` 函数之后新增纯函数：

```ts
/** #70 切换「已读完」标记。独立于 progress；命中 0 行（书不存在）抛错（镜像 updateBook）。 */
export function setBookFinished(db: DB, bookId: string, finished: boolean): BookRow {
  const row = db
    .update(books)
    .set({ isFinished: finished })
    .where(eq(books.id, bookId))
    .returning()
    .get();
  if (!row) throw new Error(`library: book ${bookId} not found`);
  return row;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS（全部用例，含既有）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/repository.ts src/main/library/repository.test.ts
git commit -m "feat(library): add setBookFinished + project isFinished in lists (#70)"
```

---

### Task 4: Handlers 胶水层 + preload API

**Files:**

- Modify: `src/main/ipc/library-handlers.ts`（import 约 8-18；`toDto` 约 49-65；binding 数组 `libraryUpdate` 之后）
- Modify: `src/renderer/preload-api.ts`（`library` 命名空间，约 41-54 行）

- [ ] **Step 1: `toDto` 加 `isFinished`**

`library-handlers.ts` 的 `toDto` 入参类型加 `isFinished: boolean;`，返回对象加：

```ts
  hasTextLayer: Boolean(b.hasTextLayer),
  isFinished: Boolean(b.isFinished),
```

- [ ] **Step 2: import 与新 binding**

把 `setBookFinished` 加入从 `@main/library/repository` 的 import 列表。在 `bind(C.libraryUpdate, …)` 之后新增：

```ts
  bind(C.librarySetFinished, (input) => {
    const book = setBookFinished(getDb(), input.bookId, input.finished);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),
```

- [ ] **Step 3: preload 暴露 setFinished**

`src/renderer/preload-api.ts` 的 `library: { … }` 块内，`update: inv(C.libraryUpdate),` 之后加：

```ts
      setFinished: inv(C.librarySetFinished),
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test src/main src/shared`
Expected: PASS（类型贯通；toDto 形状与 DTO 一致）。

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/library-handlers.ts src/renderer/preload-api.ts
git commit -m "feat(ipc): wire library:set-finished handler + preload api (#70)"
```

---

### Task 5: Renderer UI（右键菜单 + 封面角标 + mutation）

**Files:**

- Modify: `src/renderer/library/CoverImage.tsx`（封面角标）
- Modify: `src/renderer/library/BookCover.tsx`（context menu 项 + `onToggleFinished` prop）
- Modify: `src/renderer/library/SortableBook.tsx`（透传 prop）
- Modify: `src/renderer/library/LibraryView.tsx`（`setFinished` mutation + 接线 + DragOverlay noop）

UI 无 headless 单测（项目渲染层不单测），本任务靠 `pnpm typecheck`/`lint` + app 冒烟把关。

- [ ] **Step 1: 封面角标（`CoverImage.tsx`）**

引入图标：`import { Check } from "lucide-react";`。把两个返回分支包进一个 `relative` 容器并叠加角标。改写组件返回：

```tsx
const finishedBadge = book.isFinished ? (
  <span
    aria-label={t("library.finishedBadge", "已读完")}
    title={t("library.finishedBadge", "已读完")}
    className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-md"
  >
    <Check className="size-3.5" strokeWidth={3} />
  </span>
) : null;

if (book.hasCover) {
  return (
    <div className="relative">
      <img
        src={`cover://b/${encodeURIComponent(book.id)}`}
        alt=""
        loading="lazy"
        className="aspect-[2/3] w-full object-cover"
      />
      {finishedBadge}
    </div>
  );
}
const title = book.title ?? book.id;
const author = book.author ?? t("library.unknownAuthor", "未知作者");
return (
  <div className="relative">
    <div
      className={`flex aspect-[2/3] w-full flex-col justify-between bg-gradient-to-br ${coverGradientClass(book.id)} p-3 text-white`}
    >
      {withText && (
        <>
          <span className="line-clamp-4 font-serif text-base font-semibold">{title}</span>
          <span className="truncate text-xs text-white/80">{author}</span>
        </>
      )}
    </div>
    {finishedBadge}
  </div>
);
```

- [ ] **Step 2: context menu 项 + prop（`BookCover.tsx`）**

`BookCover` props 加 `onToggleFinished: () => void;`（与 `onUpdate` 并列）。在 `ContextMenuContent` 内、`library.menu.edit` 项之前加：

```tsx
<ContextMenuItem onClick={onToggleFinished}>
  {book.isFinished
    ? t("library.menu.unmarkFinished", "取消已读完")
    : t("library.menu.markFinished", "标记已读完")}
</ContextMenuItem>
```

- [ ] **Step 3: 透传 prop（`SortableBook.tsx`）**

`SortableBook` props 加 `onToggleFinished: () => void;`，并传给内层 `<BookCover … onToggleFinished={onToggleFinished} />`。

- [ ] **Step 4: mutation + 接线（`LibraryView.tsx`）**

在 `updateBook` mutation 之后新增：

```tsx
// 切换「已读完」（#70）：成功静默（角标即时刷新即反馈）；失败 toast 透传真实错误。
// qk.book(bookId) 一并失效——reader 侧栏 BookCard 共用且 staleTime=∞；shelf 也显示角标故失效 recentlyRead。
const setFinished = useMutation({
  mutationFn: (v: { bookId: string; finished: boolean }) => window.api.library.setFinished(v),
  onSuccess: (_r, v) => {
    void qc.invalidateQueries({ queryKey: qk.library });
    void qc.invalidateQueries({ queryKey: qk.book(v.bookId) });
    void qc.invalidateQueries({ queryKey: qk.recentlyRead });
  },
  onError: (e, v) => {
    const b = books.data?.find((x) => x.id === v.bookId);
    toast.error(
      t("library.setFinishedFailed", "{{title}} 标记失败：{{error}}", {
        title: b?.title ?? v.bookId,
        error: (e as Error).message,
      }),
      { closeButton: true, duration: Infinity },
    );
  },
});
```

在网格 `<SortableBook … />` 加 prop：

```tsx
                    onUpdate={(patch) => updateBook.mutate({ bookId: b.id, ...patch })}
                    onToggleFinished={() => setFinished.mutate({ bookId: b.id, finished: !b.isFinished })}
```

`DragOverlay` 内的占位 `<BookCover … />` 加 `onToggleFinished={() => {}}`。

- [ ] **Step 5: 抽取 i18n + 静态校验**

Run: `pnpm i18n:extract && pnpm typecheck && pnpm lint`
Expected: extract 把 4 个新 key（`library.menu.markFinished`/`unmarkFinished`、`library.finishedBadge`、`library.setFinishedFailed`）同步进主语言；typecheck/lint PASS。

- [ ] **Step 6: 全量测试**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/library src/shared/i18n
git commit -m "feat(library): mark book as finished — context menu + cover badge (#70)"
```

---

### Task 6: App 冒烟验收（人工）

主进程逻辑已 headless 覆盖；UI 须真机目视。**此任务交回用户验收**（用户已声明「最后验收再叫我」）。

- [ ] **Step 1: 启动 dev 产物**

`pnpm start`（dev 用 `marginalia-dev` userData，不污染正式库）。

- [ ] **Step 2: 目视检查清单**

1. 书库网格右键一本书 → 出现「标记已读完」→ 点击 → 封面右上角出现绿色 ✓ 角标。
2. 再次右键同一本 → 文案变「取消已读完」→ 点击 → 角标消失。
3. 标记一本读过的书（在「继续阅读」shelf 上的）→ shelf 缩略图也显示角标。
4. 标记态在重启 app 后保持（落库验证）。
5. 进度不受影响：标记/取消不改变阅读进度。

- [ ] **Step 3（可选）：落库核验**

```bash
sqlite3 ~/Library/Application\ Support/marginalia-dev/marginalia.db \
  "SELECT id, title, is_finished FROM books;"
```

Expected: 被标记的书 `is_finished=1`。
