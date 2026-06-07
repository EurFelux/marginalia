# 会话删除设计（Conversation Deletion）

> **日期**：2026-06-07
> **分支**：`feat/conversation-deletion`
> **状态**：**补写待审**——本 spec 在实现中途补写（流程失误：plan 未经用户审阅即开始执行）。§1–§3（主进程/IPC 层）已按本设计实现并通过双审（commits `e4db8a0`/`2d86896`/`4e53d03`/`6b7ce95`/`62cf675`）；§4–§6（渲染层 UI）**未动**，待本 spec 审阅通过后实施。若审阅推翻已实现部分的决策，按 commit 粒度返工。
> **关联**：GitHub issue #30（Ready→In progress，2026-06-07）；实现前勘察见 issue 评论（pre-implementation analysis）；镜像参照 `2026-06-03-library-context-menu-delete-design.md`（删书三件套）；实现计划 `docs/superpowers/plans/2026-06-07-conversation-deletion.md`

## 背景

侧栏会话列表（`ConversationsTab`）目前只能浏览/切换——实验性的、空的、跑偏的死会话永远堆积。需要删除能力：入口 + 确认 + 级联删消息；删除活跃会话要有合理回落。

**后端基础已就绪**（实现前已确认）：

- `messages.conversationId` FK 已 `ON DELETE CASCADE`（`schema.ts`）——删 conversations 一行即级联。
- auto-naming 竞态**天然免疫**：`nameConversation` 写回前复查 `row && row.title == null`，行已删 → `row` 为 `undefined` → 静默跳过；`namingInFlight` 内存态有 `finally` 清除，无残留。
- 镜像实现完整存在：删书 = `BookCover`（ContextMenu + AlertDialog）+ `LibraryView`（mutation + 缓存清理 + toast）+ `deleteBook`（幂等纯函数）。

**本功能特有的难点**（删书没有的）：删除**正在流式输出**的会话——主进程的流不会因为行没了而停，会继续推 chunk、并在 `onFinish` 时把 assistant 消息落到已删的会话（撞 FK）。

## 设计决策

- **DD-1 触发方式**：**右键 Context Menu + hover 垃圾桶并存**（用户拍板 2026-06-07，AskUserQuestion）——发现性（hover 可见）与一致性（与删书的右键语义同构）兼得。两条路径汇入同一确认对话框。

  > 注意与删书 DD-1（纯右键、零视觉元素）不同：封面墙有美学洁癖；会话列表行是常规列表项，hover action 是列表的惯用语汇。

- **DD-2 删除确认**：**AlertDialog 确认弹窗**（镜像删书 DD-3）——级联删消息不可逆。对话框**提升到 Tab 层共享单实例**（`confirmTarget: ConversationDto | null` state），不在每行内嵌 N 个 dialog（与 BookCover 的每卡自带不同：列表行数远多于封面卡，且两条触发路径需要汇合点）。

- **DD-3 删除活跃会话的回落**：**新会话空状态**——`setActiveConversation(null)` + `setSummaryChipsPreset()`（镜像「开书无会话」分支与「新对话」按钮的既有语义）；AIPanel 既有 effect（`activeConversationId === null → setMessages([])`）负责清面板。**不**自动切到最近会话（issue 正文定义 "falls back to the new-conversation empty state"）。下次发送由 transport 既有懒建逻辑兜底。

- **DD-4 mid-stream 删除走主进程 abort + guard 双保险**：
  - **为何不在 renderer 做**：streamId 锁在 `ipc-chat-transport` 闭包里，`ConversationsTab` 拿不到；AIPanel 的 `useChat.stop()` 也不可达（不同组件树）。
  - **abort**：`ai-handlers.ts` 的流控制器 Map 扩展为 `streamId → { controller, conversationId }` 注册表，export `abortConversationStreams(conversationId)`；`conversations:delete` binding **先 abort 后删行**。abort 后 `pumpStream` 既有逻辑发 `finish` 事件，renderer 侧 useChat 正常收尾。
  - **guard**：abort 是异步收尾——`onFinish` 落库时行可能已删。在 `runSend.onFinish` 回调体最前面查会话仍存在，不存在则 `log.debug` 后 `return`（同时跳过 auto-naming 触发）。同步回调内 check-then-act 安全（better-sqlite3 同步驱动，无写入穿插）。
  - **日志级别取 debug 而非 warn**：这是删除操作的预期后续分支、非软失败/降级——没有错误被吞（之前撞 FK 被 drain catch 吞掉 + log.warn 才是要消除的噪音）。
  - **注册表结构选型（已与用户对齐 2026-06-07）**：选**扁平单 Map**（`streamId → { controller, conversationId }`，按会话 abort 为 O(n) 线性扫描），明确放弃两个反向索引方案——①嵌套 Map（`conversationId → Map<streamId, controller>`）：高频路径 `ai:abort` 只有 streamId 取不到桶，要么变 O(n) 要么改 IPC 契约带 conversationId，本末倒置；②双 Map（原 controllers + `conversationId → Set<streamId>` 二级索引）：3 个写点（注册 / `!result.ok` / finally）均须成对操作两结构 + 空 Set 清理纪律，同步不变量换 O(1)——而 n 在现实中 ≤2（单窗口 + 发送中 Composer 锁定），无可测收益。单值变体（`Map<conversationId, streamId>`）被否：把「同会话 ≤1 流」这一 UI 涌现性质硬化为主进程不变量，覆盖丢流恰好复活本功能要防的 bug。本质是「带属性的单表扫描 vs 表+二级索引」——索引待读频率/数据量值得时再建；注册表模块私有、对外仅 `abortConversationStreams` 一个函数，将来切换不破坏调用方。

- **DD-5 缓存与时序**：mutation `onSuccess` 内**先清 active 再失效列表**（防 dangling 窗口内向已删会话发送）；该会话 messages 缓存 `removeQueries`（实体已没，不该 refetch——与 deleteBook 同理由）；会话列表 `invalidateQueries(qk.conversations(bookId))`。

- **DD-6 职责分层**：`ConversationRow`（同文件私有子组件）管自身 ContextMenu + hover 按钮，上抛 `onDeleteRequest`；`ConversationsTab` 持有 mutation、共享 AlertDialog、缓存清理与 toast（镜像删书 DD-5 的 BookCover/LibraryView 分工）。

- **DD-7 嵌套交互的结构约束**：会话行本身是 `<button>`，hover 垃圾桶**不得嵌套其中**（HTML 禁止 button 套 button）——垃圾桶为绝对定位的兄弟元素，外层 `div.group.relative` 由 `ContextMenuTrigger render` 提供。时间戳 `group-hover:opacity-0`（保留占位防行宽跳动），垃圾桶 `hidden group-hover:flex` 覆盖其位。

- **DD-8 幂等与防御边界**：`deleteConversation` 幂等（0-row delete 不抛）；重复删除/竞态安全。`conversations:delete` 不校验会话归属（任何 id 可删）——单用户本地 app，无越权面；与 `annotationsDelete` 同形状（`{ id }`，`conversationIdInput` 复用）。

## 架构 / 数据流

```
hover 垃圾桶 ──┐
右键菜单「删除」─┴─► setConfirmTarget(c) ──► AlertDialog（标题带会话名）
                                                  │ 确认
                                                  ▼
              ConversationsTab deleteConvo.mutate(c)
                                                  │
                                                  ▼
              window.api.chat.conversations.delete({ id })
                                                  │
                          ┌───────────────────────┴ (main) conversations:delete binding
                          ▼
              abortConversationStreams(id)        ← 该会话全部在跑流 abort
                          │                          └─ pumpStream → finish 事件 → renderer useChat 正常收尾
                          ▼                          └─ runSend.onFinish → guard：行已删 → 丢弃 assistant 落库
              deleteConversation(db, id)          ← messages FK 级联删
                          │ 成功返回
                          ▼ (renderer onSuccess)
              若删的是活跃会话：setActiveConversation(null) + setSummaryChipsPreset()
                          │                          └─ AIPanel effect → setMessages([])（新会话空状态）
                          ▼
              removeQueries(qk.messages(id)) → invalidateQueries(qk.conversations(bookId)) → 成功 toast
                          │ 失败
                          ▼
              错误 toast（透传真实 message，closeButton + duration Infinity）
（取消 ──► 关弹窗、无操作）
```

## §1 · 主进程纯函数（已实现，`e4db8a0`）

`src/main/chat/conversations.ts`：

```ts
/** 删除会话（messages 由 FK 级联删）；幂等——未知 id 为 0-row delete。 */
export function deleteConversation(db: DB, id: string): void {
  db.delete(conversations).where(eq(conversations.id, id)).run();
}
```

测试（`conversations.test.ts`）：级联删 messages（直接查 messages 表断言空）/ 幂等（未知 id 不抛）/ 隔离（不误删同书其他会话）。

## §2 · 在跑流注册表（已实现，`2d86896` + `4e53d03`）

`src/main/ipc/ai-handlers.ts`：`controllers: Map<string, AbortController>` → `activeStreams: Map<string, { controller, conversationId }>`；export `abortConversationStreams(conversationId)`（遍历匹配全部 abort）；`__registerStream` / `__resetStreams` 测试钩子（`__` 前缀镜像 `__resetNamingRuntime` 先例）。`aiSend` 注册时带 `input.conversationId`；清理路径不变（`!result.ok` 分支与 `pumpStream().finally`）。

测试：多流同会话全部 abort、不波及他会话；无流 no-op。

## §3 · onFinish guard + IPC 接线（已实现，`6b7ce95` + `62cf675`）

- `runSend.onFinish` 回调体最前：查 `conversations` 行存在，不存在 → `log.debug("conversation deleted mid-stream; dropping assistant persist", conversationId)` + `return`。
- 契约：`conversationsDelete: def("conversations:delete", "invoke", conversationIdInput, out<void>())`；binding：先 `abortConversationStreams(input.id)` 后 `deleteConversation(getDb(), input.id)`；preload：`chat.conversations.delete`。
- 双漂移测试（bindings-coverage / preload-api coverage）做 TDD 红灯，自动守护三端一致。
- 回归测试（send.test.ts）：慢流 → abort → delete → `finished` 顺利 resolve、无孤儿消息。**诚实标注**：此测试在 guard 前后均绿（无 guard 时 FK 错被 drain catch 吞、外部行为相同）——guard 的价值是预期分支显式化 + 消除吞错日志噪音，非行为变更。

## §4 · `ConversationsTab.tsx`（待实施）

- 行抽成私有子组件 `ConversationRow`：`ContextMenuTrigger render={<div className="group relative" />}` 包行 button 与绝对定位垃圾桶 `Button`（`variant="ghost" size="icon-sm"`，`absolute end-1 top-1/2 hidden -translate-y-1/2 ... group-hover:flex`，`Trash2` 图标，aria-label）；`ContextMenuContent` 单项 destructive「删除」。
- Tab 层：`confirmTarget` state + 共享 AlertDialog（标题 `primaryLabel(confirmTarget)`——未命名会话用既有 i18n 占位）+ `deleteConvo` mutation（onSuccess 按 DD-5 顺序；onError honest-error toast）。
- React Compiler 已启用：不写 useCallback/useMemo；逻辑方向类（`end-1`），不用物理方向类。

## §5 · i18n（新键，zh-CN primary 经 `i18n:extract`，en 手补）

| 键                                          | zh-CN                                          | en                                                                                            |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `reader.conversation.deleteAction`          | 删除会话（aria）                               | Delete conversation                                                                           |
| `reader.conversation.menu.delete`           | 删除                                           | Delete                                                                                        |
| `reader.conversation.deleteConfirm.title`   | 删除会话「{{title}}」？                        | Delete conversation "{{title}}"?（弯引号 U+201C/201D，镜像 library）                          |
| `reader.conversation.deleteConfirm.body`    | 将永久删除该会话及其全部消息。此操作不可撤销。 | This will permanently delete the conversation and all of its messages. This cannot be undone. |
| `reader.conversation.deleteConfirm.cancel`  | 取消                                           | Cancel                                                                                        |
| `reader.conversation.deleteConfirm.confirm` | 删除                                           | Delete                                                                                        |
| `reader.conversation.deleted`               | 已删除会话                                     | Conversation deleted                                                                          |
| `reader.conversation.deleteFailed`          | 删除失败：{{error}}                            | Failed to delete: {{error}}                                                                   |

> 不复用 `library.deleteConfirm.*`——跨域复用键会让两处文案被迫同步演化。

## §6 · 错误处理

- 删除失败 → 错误 toast 透传主进程真实 message（honest-error），closeButton + 不自动消失（镜像删书）。
- IPC handler 抛错由 registry catch-all 自动落盘，binding 内不重复记。
- 幂等：确认弹窗单次触发 + `deleteConversation` 0-row no-op，竞态安全。

## §7 · 测试

- 主进程：§1–§3 已有 headless 测试（级联/幂等/隔离/多流 abort/mid-stream 回归），双漂移测试守三端。
- 渲染层无新纯逻辑（无可抽 helper）——`pnpm typecheck` + `pnpm lint` + 手动冒烟：hover/右键两入口 → 确认框 → 删非活跃（列表消失+toast）/ 删活跃（面板回空态+chips 预亮）/ **删正在流式的活跃会话**（流停、无报错、main log 无 FK 错）/ 取消无操作。

## §8 · 范围外（YAGNI）

- 无撤销/软删（与删书同理：物理删，撤销需改后端）。
- 不做批量删除/全部清空。
- 菜单仅「删除」一项（结构可扩展：重命名、导出等将来再说）。
- 不处理跨窗口（单窗口 app）。
- `conversations:get` 仍 main-only，不顺手暴露。

## 设计决策记录（速查）

- **DD-1**：右键菜单 + hover 垃圾桶并存（用户拍板），汇入同一确认。
- **DD-2**：AlertDialog 确认，Tab 层共享单实例（`confirmTarget`）。
- **DD-3**：删活跃会话 → 新会话空状态（null + chips 预亮），不自动切最近。
- **DD-4**：mid-stream = 主进程按会话 abort（注册表）+ onFinish guard（debug 级日志）双保险；注册表取扁平单 Map、按会话 abort O(n) 扫描（n≤2，放弃反向索引，已与用户对齐）。
- **DD-5**：onSuccess 先清 active 再失效；messages 用 removeQueries、列表用 invalidate。
- **DD-6**：ConversationRow 管入口、Tab 管 mutation/确认/toast。
- **DD-7**：垃圾桶为绝对定位兄弟（不嵌套 button）；时间戳 opacity 让位。
- **DD-8**：幂等删除；`{ id }` 契约复用 `conversationIdInput`。
