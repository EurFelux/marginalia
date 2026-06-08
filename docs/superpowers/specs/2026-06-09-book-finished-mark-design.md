# 书籍「已读完」标记 — 设计

- 日期：2026-06-09
- Issue：[#70](https://github.com/EurFelux/marginalia/issues/70) Add ability to mark a book as finished/read
- 类型：enhancement · area:library

## 目标

让用户在书库里把一本书显式标记为「已读完」，并在封面上一眼可辨。标记是**手动、可切换、独立**的状态——不是从阅读进度派生，也不影响进度。

## 非目标（YAGNI）

- **不**在阅读进度到 100% 时自动标记（issue 里的「consider auto-suggest」本版砍掉——阈值/重读是否取消等问题不值当下引入）。
- **不**与 `progress` 表耦合：已读完的书保留其进度；重新打开不会清除「已读完」。
- **不**做按「未读完」筛选/排序（远期可加，本版只落「标记 + 展示」最小闭环）。
- **不**做乐观更新：本地 IPC 亚毫秒，沿用 `updateBook` 的 invalidate-刷新即可。

## 数据模型

`books` 表新增一列：

```ts
isFinished: integer("is_finished", { mode: "boolean" }).notNull().default(false);
```

- 布尔以 SQLite integer 0/1 存（与既有 `is_builtin`/`has_text_layer` 同款）。
- 迁移由 `pnpm db:generate` 生成，预期为单条 `ALTER TABLE books ADD is_finished integer DEFAULT 0 NOT NULL;`（存量书默认「未读完」，无需表重建）。

## 契约变更（`src/shared/`）

1. `BookSummaryDto` 新增 `isFinished: boolean`（`RecentlyReadDto extends BookSummaryDto`，shelf 自动获得）。
2. 新输入 schema：

   ```ts
   export const setBookFinishedInput = z.object({
     bookId: z.string().min(1),
     finished: z.boolean(),
   });
   export type SetBookFinishedInput = z.infer<typeof setBookFinishedInput>;
   ```

3. 新 IPC 通道：`librarySetFinished: def("library:set-finished", "invoke", setBookFinishedInput, out<BookSummaryDto>())`，返回更新后的 DTO（与 `libraryUpdate` 对称，供调用方就地刷新）。

## 主进程变更（`src/main/`）

- `repository.ts`
  - `listBooks` / `listRecentlyRead` 的 select 增列 `isFinished: books.isFinished`。
  - 新纯函数 `setBookFinished(db, bookId, finished): BookRow`——`UPDATE books SET is_finished=? WHERE id=? RETURNING *`，命中 0 行抛 `book ${id} not found`（镜像 `updateBook`）。
- `library-handlers.ts`
  - `toDto` 增 `isFinished: Boolean(b.isFinished)`（布尔化口径与 `hasCover`/`hasTextLayer` 一致）。
  - 新绑定 `bind(C.librarySetFinished, (input) => toDto({ ...setBookFinished(getDb(), input.bookId, input.finished), hasCover: ... }))`。

## 预加载（`src/renderer/preload-api.ts`）

`library` 命名空间增 `setFinished: inv(C.librarySetFinished)`。

## 渲染层变更（`src/renderer/`）

### 交互：书库右键菜单

`BookCover.tsx` 的 `ContextMenu` 在「编辑信息」上方加一项，按 `book.isFinished` 切换文案与动作：

- 未读完 → 「标记已读完」`library.menu.markFinished`
- 已读完 → 「取消已读完」`library.menu.unmarkFinished`

新增 prop `onToggleFinished: () => void`，经 `SortableBook` 透传（与既有 `onUpdate`/`onDelete` 同款 prop 链；`DragOverlay` 里的占位 `BookCover` 传 noop）。

### 状态：`LibraryView.tsx` mutation

新增 `setFinished` mutation：

```ts
mutationFn: (v: { bookId: string; finished: boolean }) => window.api.library.setFinished(v)
onSuccess: 失效 qk.library + qk.book(bookId) + qk.recentlyRead
onError: toast 透传主进程真实错误（honest-error，不自动消失）
```

`qk.book(bookId)` 必须失效——reader 侧栏 `BookCard` 与面包屑共用、且 `staleTime=∞`。

### 视觉：封面角标

`CoverImage.tsx` 把两个返回分支（`<img>` / 渐变 tile）包进一个 `relative` 容器，`book.isFinished` 时叠加右上角徽标：

- 绝对定位右上角，`bg-emerald-600 text-white rounded-full`，内含 lucide `Check` 图标（小尺寸）。
- 语义色沿用 `BookCard` 中 ready 的 emerald 口径，保持视觉一致。
- `aria-label`/`title` = `library.finishedBadge`「已读完」。
- 几何（尺寸/间距/圆角）一律 Tailwind 静态类，不内联 style。

徽标在书库网格、「继续阅读」shelf、拖拽 overlay 处一致出现（皆走 `CoverImage`，且 DTO 已带 `isFinished`）。

## i18n

新增 key（带中文 fallback，后续 `pnpm i18n:extract` 同步）：

- `library.menu.markFinished`「标记已读完」
- `library.menu.unmarkFinished`「取消已读完」
- `library.finishedBadge`「已读完」
- `library.setFinishedFailed`「{{title}} 标记失败：{{error}}」

## 测试策略

主进程 headless（vitest + `:memory:`），UI 留 app 冒烟验收。

- `repository.test.ts`
  - 导入后默认 `isFinished=false`。
  - `setBookFinished` true→持久化、返回行 `isFinished=true`；再 false→翻回。
  - 缺失 bookId 抛 not found。
  - `listBooks` / `listRecentlyRead` 投影含 `isFinished`。
- `shared/library.test.ts`
  - `setBookFinishedInput`：接受合法、拒空 bookId、拒非布尔 `finished`、拒缺 `finished` 键。
- IPC 漂移测试（`ipc.test.ts`）`Object.entries(C)` 自动收纳新通道（唯一性/kind/input schema），无需手写。

## 实现顺序（垂直切片，层间顺序依赖）

schema + 迁移 → 契约（DTO/input/channel）→ repository（含测试）→ handlers → preload-api → renderer（mutation + 菜单 + 徽标）→ i18n extract → typecheck/lint/test → app 冒烟。

层间是顺序依赖（非独立任务），故 inline TDD 推进，不拆并行 subagent。
