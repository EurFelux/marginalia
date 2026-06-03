# 书库书籍右键菜单 + 删除设计

> **日期**：2026-06-03
> **分支**：`feat/library-context-menu`（基于含封面墙的 main）
> **状态**：设计定稿，待 plan
> **关联 backlog**：用户 2026-06-03 指定——「为书库中的每本书添加 Context Menu，需要能够删除书籍」

## 背景

封面墙（Apple Books 风）已交付：`LibraryView` 把每本书渲染成纯封面 `<button>`（`BookCover`，左键开书）。本功能给每张封面加**右键 Context Menu**，当前仅一项「删除」。

**后端已就绪**（#9 P3 落地，本功能不动主进程）：

- `repository.ts`：`deleteBook(db, booksDir, bookId)`——先 DB 级联删（6 个 book-owned FK 全 `ON DELETE CASCADE`），后 best-effort `unlink` 自有 epub 副本；删不存在的书是 no-op、不抛。
- IPC：`IPC.libraryDelete = "library:delete"`，handler `handle<{ bookId }, void>(IPC.libraryDelete, bookIdInput, (input) => deleteBook(getDb(), getBooksDir(), input.bookId))`。
- preload：`window.api.library.delete(input: BookIdInput): Promise<void>`。
- `deleteBook` 已有 headless 测（P3 `repository.test.ts`：级联删 / 删文件 / 容忍缺失文件 / 幂等）。

故本功能**纯渲染层**：右键菜单 UI + 确认弹窗 + 调既有删除 IPC + 刷新书库查询。

## 设计决策（已与用户确认）

- **DD-1 触发方式**：**纯右键 Context Menu**——右键 / Control-click / 触控板双指点封面弹菜单。零额外视觉元素，最贴合「Context Menu」语义与 Apple Books 干净封面墙美学。（放弃 hover「⋯」按钮方案。）
- **DD-2 菜单范围**：**仅「删除」一项**（destructive 红色样式）。ContextMenu 结构可扩展，后续「打开 / 简介 / 重新导入」等再加（YAGNI）。
- **DD-3 删除确认**：**AlertDialog 确认弹窗**——`deleteBook` 不可逆（级联删 DB + 物理 unlink epub 副本），点「删除」后弹确认框，确认才删。放弃「立即删 + 撤销 toast」（后端已物理删，真撤销需改后端为软删/延迟删，超范围）。
- **DD-4 实现结构**：按项目惯例**新增 `components/ui/context-menu.tsx` 与 `alert-dialog.tsx`** shadcn 风包装组件（手写包装 `@base-ui/react` 现成 primitive，**仿 `dialog.tsx` 模式**——`cn` + 现有 token + `render` prop + `data-slot`）。**不跑 shadcn CLI**（primitive 已随 `@base-ui/react` 安装，无新依赖，故不触发重装 / better-sqlite3 ABI 翻转）。
- **DD-5 职责分层**：`BookCover` 负责右键菜单 + 确认弹窗的本地开合（确认文案需书名，天然在此），确认后调 `onDelete` 回调；`LibraryView` 持有删除 mutation（它本就持有 `books` 查询）、管失效刷新与 toast。

## 架构 / 数据流

```
右键封面 ──► ContextMenu 弹出 ──► 点「删除」──► AlertDialog 确认框（标题带书名）
                                                      │ 确认
                                                      ▼
BookCover.onDelete() ──► LibraryView deleteBook.mutate(bookId)
                              │
                              ▼
window.api.library.delete({ bookId }) ──► (主进程已就绪) deleteBook
                              │ 成功
                              ▼
invalidateQueries(qk.library) ──► 封面从网格消失 + 成功 toast
                              │ 失败
                              ▼
错误 toast（透传真实 message）
（取消 ──► 关弹窗、无操作）
```

## §1 · `components/ui/context-menu.tsx`（新）

包装 `@base-ui/react/context-menu`（命名空间 `ContextMenu.{Root,Trigger,Portal,Positioner,Popup,Item}`），仿 `dialog.tsx`：`cn` + 现有 token + `data-slot` + Base UI 的 `render` prop 合并。导出：

- `ContextMenu`（= `ContextMenu.Root`）。
- `ContextMenuTrigger`（= `ContextMenu.Trigger`）——经 Base UI `render` prop **渲染为现有封面 `<button>` 本身**（不额外套 wrapper 元素），把 contextmenu 监听合并到该 button 上：左键照常触发 button 的 `onClick`（开书），右键唤起菜单。
- `ContextMenuContent`（= `Portal` + `Positioner` + `Popup`）——浮层样式复用 popover/dialog 的 token（`bg-popover`、`ring-1 ring-foreground/10`、`rounded-md`、进出动画 `data-open/closed:animate-*`）。
- `ContextMenuItem`（= `ContextMenu.Item`）——支持 `variant?: "default" | "destructive"`；destructive 用 `text-destructive` + `hover/focus:bg-destructive/10`（与 AnnotationsList 删除图标的既有 destructive hover 语汇一致）。

> 仅导出本功能所需部件；`Separator`/`Group` 等待菜单加项时再补（YAGNI）。

## §2 · `components/ui/alert-dialog.tsx`（新）

包装 `@base-ui/react/alert-dialog`（`AlertDialog.{Root,Portal,Backdrop,Popup,Title,Description,Close}`），仿 `dialog.tsx`。**受控**打开（程序化，无 `Trigger`——由菜单项 onClick 置 `open`）。导出：

- `AlertDialog`（受控 `Root`，`open` / `onOpenChange`）。
- `AlertDialogContent`（`Portal` + `Backdrop`(遮罩) + `Popup`），样式同 `DialogContent`（居中、`bg-popover`、动画）。
- `AlertDialogTitle` / `AlertDialogDescription`（同 dialog 版样式）。
- `AlertDialogFooter`（按钮行，`flex-col-reverse sm:flex-row sm:justify-end gap-2`）。
- `AlertDialogCancel`（`render={<Button variant="outline" />}`，`AlertDialog.Close`）/ `AlertDialogAction`（`render={<Button variant="destructive" />}`，点击触发确认回调；`AlertDialog` 无内置 confirm 语义，故 Action 走普通 Button + onClick）。

## §3 · `BookCover.tsx`（改）

- 新增 prop：`onDelete: () => void`。
- 本地状态 `confirmOpen`（受控 AlertDialog）。
- 结构：`<ContextMenu><ContextMenuTrigger render={<现有封面 button/>}>…</ContextMenuTrigger><ContextMenuContent><ContextMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>{t("library.menu.delete")}</ContextMenuItem></ContextMenuContent></ContextMenu>` + 受控 `<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>` 含标题（带书名）/正文/取消/删除；删除按钮 onClick → `onDelete()` + 关弹窗。
- 左键开书（现有 `onOpen`）、右键弹菜单两不相扰。

## §4 · `LibraryView.tsx`（改）

- 加 `deleteBook` mutation：`mutationFn: (bookId) => window.api.library.delete({ bookId })`；`onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.library }); toast.success(t("library.deleted", …, { title })) }`；`onError: (e, bookId) => toast.error(t("library.deleteFailed", …, { title, error: (e as Error).message }))`（透传真实 message，遵循 honest-error）。
- grid：`<BookCover book={b} onOpen={() => openBook(b.id)} onDelete={() => deleteBook.mutate(b.id)} />`。

## §5 · i18n（新键，zh-CN/en 双语，走 `i18n:extract`）

| 键                              | zh-CN                                                                            | en                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `library.menu.delete`           | 删除                                                                             | Delete                                                                                                                                   |
| `library.deleteConfirm.title`   | 删除《{{title}}》？                                                              | Delete "{{title}}"?                                                                                                                      |
| `library.deleteConfirm.body`    | 将永久移除这本书及其所有标注、笔记、对话，以及导入的 epub 副本。此操作不可撤销。 | This permanently removes the book and all its annotations, notes, and conversations, plus the imported epub copy. This cannot be undone. |
| `library.deleteConfirm.cancel`  | 取消                                                                             | Cancel                                                                                                                                   |
| `library.deleteConfirm.confirm` | 删除                                                                             | Delete                                                                                                                                   |
| `library.deleted`               | 已删除《{{title}}》                                                              | Deleted "{{title}}"                                                                                                                      |
| `library.deleteFailed`          | {{title}} 删除失败：{{error}}                                                    | Failed to delete {{title}}: {{error}}                                                                                                    |

> 确认标题/toast 的 `{{title}}` 用 `book.title ?? book.id`（与 `BookCover` 现有兜底一致）。

## §6 · 错误处理

- 删除失败 → 错误 toast 透传 provider/OS 真实 message（不编造，遵循 honest-error 记忆）。`deleteBook` DB-first、文件 unlink best-effort（缺失不抛），故几乎不失败。
- 幂等：重复点删除（确认弹窗已关，按钮单次触发）+ 后端 `deleteBook` 删不存在的书 no-op，故竞态安全。

## §7 · 测试

- 后端 `deleteBook` 已有 headless 测（P3），本功能不重复。
- 本功能纯渲染层、**无新纯逻辑**（无 cover-palette 式可测 helper）——`pnpm typecheck` + `pnpm lint` + 手动 `pnpm start` 验：右键封面弹菜单 → 删除 → 确认弹窗 → 确认后书从网格消失 + 成功 toast；取消无操作；核对 DB 行与 `userData/books/<sha256>.epub` 副本已删。新增的 `context-menu.tsx`/`alert-dialog.tsx` 为 Base UI 包装组件，按项目惯例手测。

## §8 · 范围外（YAGNI）

- 菜单仅「删除」一项（结构可扩展）。
- 不接管 hover 视觉提示（DD-1 纯右键）。
- 不处理「删除当前正在 reader 中打开的书」边角（LibraryView 场景下通常无此态；留待需要时）。
- 无撤销 / 回收站（DD-3：后端物理删，软删超范围）。

## 设计决策记录（速查）

- **DD-1**：纯右键 Context Menu（无 hover 按钮）。
- **DD-2**：菜单仅「删除」（destructive），结构可扩展。
- **DD-3**：AlertDialog 确认（不可逆删除，无撤销）。
- **DD-4**：新增 `context-menu.tsx`/`alert-dialog.tsx` shadcn 风包装（仿 `dialog.tsx`，不跑 CLI、不触发重装）。
- **DD-5**：`BookCover` 管菜单/确认本地态 + `onDelete` 回调；`LibraryView` 管 mutation/失效/toast。
