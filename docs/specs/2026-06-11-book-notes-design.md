# 书籍级独立笔记（Book Notes）设计

- 日期：2026-06-11
- Issue：[#79 Add standalone book-level notes](https://github.com/EurFelux/marginalia/issues/79)
- 状态：已与用户对齐定稿（含可视化伴侣 mockup v2 确认）

## 背景与动机

读者想对一本书整体记录想法（读后感、章节心得、待回顾的问题），不必先选中一段正文。现状是唯一的笔记载体挂在选区标注上：`annotations` 表的 `selected_text` / `locator_range` 均为 NOT NULL，笔记必须有锚点；也没有任何「对这本书写点什么」的 UI 入口。

## 需求决策（已确认）

| 决策点   | 结论                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 笔记形态 | **多条笔记流**（每条带创建/更新时间），非单篇长文档                              |
| 内容格式 | **Markdown**（存源码，展示时渲染）                                               |
| UI 入口  | **阅读器侧栏第 4 个 tab** + **书库书卡右键「查看笔记」Dialog**，两处渲染同一组件 |
| 编辑形态 | **居中编辑 Dialog**（镜像 annotation 的 NoteModal 交互），列表卡片只读           |
| AI 集成  | **首版不喂** AI 上下文（YAGNI；表结构不堵路，后续单独 issue）                    |
| 数据模型 | **新表 `book_notes`**，不放松 `annotations` 的锚点不变量                         |

## 范围外（明确不做）

- 笔记注入 AI 对话/摘要上下文
- 标注 + 笔记统一时间线视图（将来可在查询层合并）
- 单篇置顶「总笔记」
- 从书库 Dialog 跳转进阅读器的路由联动

## 数据层

新表 `book_notes`（`src/main/db/schema.ts`，改完跑 `pnpm db:generate` 生成迁移）：

| 列           | 类型/约束                                                                        |
| ------------ | -------------------------------------------------------------------------------- |
| `id`         | text PK，应用侧 uuidv7（沿用 `pkUuid()`）                                        |
| `book_id`    | text NOT NULL → `books.id`，`onDelete: cascade`，建索引 `book_notes_book_id_idx` |
| `content`    | text NOT NULL（Markdown 源码；trim 后非空，由 Zod 入口校验）                     |
| `created_at` | integer NOT NULL（沿用 `nowMs()` 模式）                                          |
| `updated_at` | integer NOT NULL（更新时刷新为 `Date.now()`）                                    |

不需要 `style`、锚点等字段；与 `annotations` 完全独立，互不影响不变量。

## 共享契约（`src/shared/`）

新文件 `src/shared/book-notes.ts`：

- `BookNoteDto`：`{ id, bookId, content, createdAt, updatedAt }`（readonly、JSON 可序列化）
- Zod inputs：
  - `createBookNoteInput`：`{ bookId, content }`，`content` 经 `.trim().min(1)` 校验
  - `updateBookNoteInput`：`{ id, patch: { content } }`，同上校验
  - `bookNoteIdInput`：`{ id }`
  - list 复用既有 `bookIdInput` 模式

`src/shared/ipc.ts` 注册四条通道（镜像 annotations 命名）：

| 契约                    | 通道                      |
| ----------------------- | ------------------------- |
| `C.bookNotesListByBook` | `book-notes:list-by-book` |
| `C.bookNotesCreate`     | `book-notes:create`       |
| `C.bookNotesUpdate`     | `book-notes:update`       |
| `C.bookNotesDelete`     | `book-notes:delete`       |

## 主进程

新文件 `src/main/library/book-notes.ts`（纯函数，注入 `DB`，不触 Electron）：

- `listBookNotesByBook(db, bookId): BookNoteDto[]` — `createdAt` 降序（与标注列表一致，最新在前）
- `createBookNote(db, input): BookNoteDto` — 先查书存在，缺书抛可读错误（镜像 `createAnnotation` 的 FK 预检）
- `updateBookNote(db, input): BookNoteDto` — 缺行抛可读错误，刷新 `updatedAt`
- `deleteBookNote(db, id): void` — 缺行抛可读错误

新文件 `src/main/ipc/book-notes-handlers.ts`：`bind(contract, fn)` + `register(bindings)`，`getDb()` 注入，按 `annotations-handlers.ts` 样板。

`src/preload-api.ts`：挂 `window.api.bookNotes.{listByBook, create, update, delete}`。

错误处理：handler 抛错由 `registry.ts` catch-all 统一落盘，模块内不重复记日志；渲染层 mutation 失败用 sonner toast 提示（既有惯例，不用 OS 弹窗）。

## 渲染层

新目录 `src/renderer/book-notes/`（被 reader 与 library 两处消费）：

### `BookNotesPanel.tsx`（共享列表组件）

- 顶部整宽「＋ 新建笔记」按钮 → 打开编辑 Dialog（create 模式）
- 下方笔记卡片列表（`createdAt` 降序）：
  - 卡片只读：`LocalizedStreamdown` 渲染 Markdown + 相对时间戳
  - 卡片右下角操作：✏️ 编辑（打开编辑 Dialog 的 edit 模式）、🗑 删除（`AlertDialog` 确认后删）
- 数据：`qk.bookNotes(bookId)` query key + `bookNotesQuery(bookId)` 工厂，`useQuery` / `useMutation` + `invalidateQueries`。笔记无主进程后台推进，不需要轮询/staleTime 特殊化。
- 空态：简短引导文案（i18n）。

### `BookNoteEditorDialog.tsx`（新建/编辑共用）

- 居中 Dialog，镜像 `NoteModal.tsx` 的交互契约：打开即聚焦、⌘/Ctrl+Enter 保存、ESC/遮罩取消
- textarea 比 NoteModal 更高（约 `min-h-55`，写长笔记舒展），保存前 trim、空内容不提交
- 辅助文案标注「支持 Markdown」
- 书库场景下是 Dialog 套 Dialog（编辑层叠在笔记列表 Dialog 之上），Base UI 原生支持嵌套

### 挂载点 ① 阅读器侧栏（`src/renderer/reader/Sidebar.tsx`）

- 新增第 4 个 tab：`value="book-notes"`，图标 `NotebookPen`（lucide），label `t("reader.bookNotes", "笔记")`
- 现有「标注」tab 的 `value="notes"` 保持不动（避免无谓改动）
- 沿用现有 trigger 模式（选中态才显示文字、`aria-label` 兜底）

### 挂载点 ② 书库书卡（`src/renderer/library/BookCover.tsx`）

- 右键 ContextMenu 新增「查看笔记」项 → 打开 Dialog（标题含书名），内容渲染同一个 `BookNotesPanel`，完整 CRUD，不加载书

## i18n

新增 key（tab 标签、新建/编辑/删除文案、空态、占位符、Markdown 提示、删除确认等），文案改完跑 `pnpm i18n:extract`（先于 typecheck）。

## 测试策略

vitest（`:memory:` SQLite，纯主进程无头）：

- `src/main/library/book-notes.test.ts`：
  - create → list 回读；list 按 `createdAt` 降序
  - update 改 content 且 `updatedAt` 刷新
  - delete 后 list 不含该条
  - 缺书 create、缺行 update/delete 抛可读错误
  - 删 book 级联清空其 book_notes
- Zod 校验：`content` 空串/纯空白被拒（create 与 update patch）
- 渲染层不写单测（项目惯例）；交付前 CDP 冒烟覆盖两个入口（侧栏 tab 与书库 Dialog）的建/改/删/渲染

## 交付物清单

| 层     | 文件                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB     | `src/main/db/schema.ts`（+ 生成的迁移目录）                                                                                                                                                                             |
| 共享   | `src/shared/book-notes.ts`、`src/shared/ipc.ts`                                                                                                                                                                         |
| 主进程 | `src/main/library/book-notes.ts`、`src/main/ipc/book-notes-handlers.ts`、`src/preload-api.ts`                                                                                                                           |
| 渲染层 | `src/renderer/book-notes/BookNotesPanel.tsx`、`src/renderer/book-notes/BookNoteEditorDialog.tsx`、`src/renderer/reader/Sidebar.tsx`、`src/renderer/library/BookCover.tsx`、`src/renderer/query/keys.ts`（+ query 工厂） |
| 测试   | `src/main/library/book-notes.test.ts` 等                                                                                                                                                                                |
| 其他   | i18n locales、changeset                                                                                                                                                                                                 |
