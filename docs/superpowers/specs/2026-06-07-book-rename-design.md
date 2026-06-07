# 书籍信息编辑（重命名）设计

日期：2026-06-07
状态：已与用户对齐（编辑范围、空值语义、交互形态三个决策点已确认），待实现
关联：GitHub issue #29（P1，`enhancement` + `polish` / `area:library`）；实现前勘察见 issue 评论（2026-06-07 预实现分析）

## 1. 背景与动机

书名与作者在导入时一次性确定（ePub 元数据 / PDF 元数据 → 文件名回退 → null），之后无法修正。脏元数据（z-lib 重打包带站点后缀）或缺失书名（书库卡片显示 64 位 id 哈希）目前只能删了重导——而重导也改不了元数据本身。需要在书库卡片右键菜单提供「编辑信息」入口，持久化到 `books.title` / `books.author`。

## 2. 决策摘要

| 决策点     | 结论                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编辑范围   | **书名 + 作者一起编辑**（issue 即提 "consider author too"；脏元数据通常两个字段都脏，双字段 Dialog 与单字段成本几乎一样）                                                 |
| 空值语义   | **书名必填**（trim 后为空禁用保存——没人想看回退的 id 哈希）；**作者可清空**（空串 → 存 `null`，回到「未知作者」显示，语义自然）                                           |
| 交互形态   | **右键菜单 →「编辑信息」Dialog**（双字段表单）。inline 编辑被排除（有封面图的书没有文字可点、双字段放不下）；书籍详情浮层被排除（需先发明详情页，YAGNI）                  |
| IPC 语义   | **put 而非 patch**：`title`、`author` 都必传（`author` 可为 `null`）。UI 是双字段表单一起保存，put 免去「`undefined` = 不改 vs `null` = 清空」的微妙区分                  |
| 返回值     | 更新后的 `BookSummaryDto`（与 `libraryImport` 返回 DTO 的惯例一致，成本为零）；renderer 不依赖它做 `setQueryData`，统一走 invalidate                                      |
| DB 迁移    | **无**：`books.title` / `books.author` 本就是无约束 nullable text                                                                                                         |
| 重导入覆盖 | **天然安全，无需处理**：导入幂等检查是 early return（`repository.ts` 的 `if (existing) return existing`），重导同一文件根本不会走到 insert，手动改名不会被解析元数据冲掉  |
| 缓存一致性 | 保存成功后 invalidate `qk.library` **和** `qk.book(bookId)`——后者有两个消费点（reader 侧栏 `BookCard` + 顶栏面包屑 `ReaderView`），且渲染层 staleTime=∞，不失效就永远陈旧 |
| 成功反馈   | 静默（卡片标题即时刷新就是反馈）；**失败必须 toast**，透传主进程真实错误（honest-error），`closeButton` + `duration: Infinity`，与删除失败模式一致                        |
| 顺手项     | 修正 `schema.ts` `books.id` 过时列注释（现仍写「ePub 自然键」，未提 PDF 恒文件哈希的分支）；「统一 id 为 contentHash」议题已另记 #50（P2 debt），不入本范围               |

## 3. 数据流（IPC 脊柱五层）

```
BookCover（ContextMenu「编辑信息」→ Dialog 表单）
  → onUpdate prop → LibraryView.updateBook mutation
  → window.api.library.update({ bookId, title, author })
  → preload-api: inv(C.libraryUpdate)
  → ipcMain → registry.bind(C.libraryUpdate) → validateInput(updateBookInput)
  → repository.updateBook(db, input)  ← 纯函数，vitest 可测
  → 返回更新后 BookRow → toDto → renderer
  → onSuccess: invalidate qk.library + qk.book(bookId)
```

### 3.1 Shared（`src/shared/library.ts` + `src/shared/ipc.ts`）

```ts
export const updateBookInput = z.object({
  bookId: z.string().min(1),
  title: z.string().trim().min(1).max(500), // 必填：trim 后非空；max 防极端输入
  author: z.string().trim().min(1).max(500).nullable(), // null = 清空 →「未知作者」
});
export type UpdateBookInput = z.infer<typeof updateBookInput>;
```

通道（`ipc.ts` library 段，紧随 `libraryDelete`）：

```ts
libraryUpdate: def("library:update", "invoke", updateBookInput, out<BookSummaryDto>()),
```

注意 `author` 用 `.nullable()` 而非 `.optional()`——put 语义，`null` 是显式「清空」，缺省不合法。
空串收敛（`"" → null`）在 **renderer 表单提交时**完成，schema 端 `min(1)` 拒绝空串以防绕过 UI 的脏输入。

### 3.2 Main 纯函数（`src/main/library/repository.ts`）

```ts
export function updateBook(
  db: DB,
  input: { bookId: string; title: string; author: string | null },
): BookRow;
```

- `UPDATE books SET title = ?, author = ? WHERE id = ?`，随后 select 返回更新行
- 书不存在 → 抛 `library: book <id> not found`（与 `libraryReadBookBytes` 的 not-found 惯例一致；registry catch-all 自动落盘日志，函数内无需重复记录）
- 不触碰其他列（cover/toc/progress/summary 等）

### 3.3 胶水（`src/main/ipc/library-handlers.ts`）

```ts
bind(C.libraryUpdate, (input) => {
  const book = updateBook(getDb(), input);
  return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
}),
```

`bindings-coverage.test.ts` 会自动强制新通道有 binding，零额外接线工作。

### 3.4 Preload（`src/preload-api.ts`）

`library` 段加一行：`update: inv(C.libraryUpdate)`。

### 3.5 Renderer

**`LibraryView.tsx`** —— 新增 mutation（与 `deleteBook` 同模式同位置）：

```ts
const updateBook = useMutation({
  mutationFn: (input: UpdateBookInput) => window.api.library.update(input),
  onSuccess: (_r, input) => {
    void qc.invalidateQueries({ queryKey: qk.library });
    void qc.invalidateQueries({ queryKey: qk.book(input.bookId) });
  },
  onError: (e, input) => {
    toast.error(
      t("library.updateFailed", "{{title}} 保存失败：{{error}}", {
        title: input.title,
        error: (e as Error).message,
      }),
      { closeButton: true, duration: Infinity },
    );
  },
});
```

`BookCover` 接新 prop：`onUpdate: (patch: { title: string; author: string | null }) => void`；
列表处挂接补 bookId：`onUpdate={(patch) => updateBook.mutate({ bookId: b.id, ...patch })}`。

**`BookCover.tsx`** —— ContextMenu 在 Delete **上方**加「编辑信息」项（destructive 项保持在尾部惯例）；新增受控 Dialog（`components/ui/dialog.tsx` 现成）：

- 字段：书名（`Input` + `Label`）、作者（`Input` + `Label`）
- 打开时预填当前值：`book.title ?? ""`（**不预填 id 哈希**——哈希是显示回退，不是数据）、`book.author ?? ""`
- 作者输入框 placeholder 提示可清空语义（「留空显示未知作者」）
- 保存按钮：`title.trim() === ""` 时 disabled
- 提交：`onUpdate({ title: title.trim(), author: author.trim() || null })` → 关 Dialog（fire-and-forget，与删除确认同模式；失败由 mutation 的 toast 兜住）
- 表单 local state 在 Dialog 打开时从 `book` 重置（受控 `open` 切换时同步）

## 4. UI 文案与 i18n

en + zh-CN 双语新键（代码内默认值为中文，与既有 `t("key", "中文")` 模式一致）：

| 键                                     | zh-CN                         | en                                  |
| -------------------------------------- | ----------------------------- | ----------------------------------- |
| `library.menu.edit`                    | 编辑信息                      | Edit details                        |
| `library.editDialog.title`             | 编辑书籍信息                  | Edit book details                   |
| `library.editDialog.bookTitle`         | 书名                          | Title                               |
| `library.editDialog.author`            | 作者                          | Author                              |
| `library.editDialog.authorPlaceholder` | 留空则显示「未知作者」        | Leave empty for unknown author      |
| `library.updateFailed`                 | {{title}} 保存失败：{{error}} | {{title}} failed to save: {{error}} |

取消/保存按钮复用既有 `common.cancel` / `common.save`，不另建键。`updateFailed` 的 en 措辞对齐既有 `deleteFailed`（`{{title}} failed to delete: {{error}}`）。

i18n 操作注意（既有坑）：extract 先于 typecheck 跑；extract 可能用旧 fallback 反向覆盖 locale 修正，提交前 diff 校验两个 locale 文件。

## 5. 错误处理

| 层       | 失败模式            | 处理                                                               |
| -------- | ------------------- | ------------------------------------------------------------------ |
| UI       | 空书名              | 保存按钮 disabled（第一道防线）                                    |
| IPC 边界 | 绕过 UI 的空串/超长 | Zod `min(1)`/`max(500)` 拒绝，`validateInput` 抛带通道名的可读错误 |
| Main     | 书不存在（已被删）  | `updateBook` 抛 not-found；registry catch-all 落盘日志             |
| Renderer | mutation 失败       | toast 透传真实错误（honest-error），不自动消失                     |

## 6. 测试

- **`repository` vitest（`:memory:`，主战场）**：
  - 更新 title + author 持久化生效
  - `author: null` 清空生效
  - 不存在的 bookId 抛 not-found
  - 不触碰其他列（cover/toc 不变）
- **schema**：`updateBookInput` 拒绝空 title / 缺 author 字段；trim 行为（`"  x  "` → `"x"`）
- **bindings 覆盖**：`bindings-coverage.test.ts` 既有机制自动强制
- **renderer**：Dialog 交互不写自动化测试（与现状一致，renderer 测试只覆盖纯逻辑）；手动冒烟：改名 → 卡片即时刷新 → 开书验证 reader 侧栏/面包屑同步 → 重启验证持久化

## 7. 范围外（YAGNI）

- 阅读器内编辑入口（issue 只要求 library context menu）
- 封面替换、其他元数据字段（语言/出版社等）
- 「恢复为解析元数据」撤销机制（重导不覆盖手动改名，反向恢复无人要求）
- #27（删除/重链接）、#30 的菜单扩展——本设计为它们留出的只是同一 ContextMenu 的插入点
