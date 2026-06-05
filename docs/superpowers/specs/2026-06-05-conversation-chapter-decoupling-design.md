# Conversation 与 Chapter 解耦设计

日期：2026-06-05
状态：已与用户对齐，待实现

## 1. 背景与动机

当前会话模型是**章节粒度**：`conversations.chapterId` 绑定单一章节（NULL = 「独立会话」），`routeConversation` 在用户跨章划词提问时强制新建会话。实际使用反馈：

- **阅读体验是连续的**，跨章自动新建会话直接打断会话连续性——读到下一章想接着问上一个问题，被迫从零开始；
- 会话 tab 每个 item 显示章节名副标签，**占用空间**且信息价值低。

关键洞察：上下文锚定其实已经是**消息级**的——每条 user 消息的选区/段落 chips 快照存于 `metadata.contextChips`；章节摘要按「当前阅读位置」（`input.currentChapterId`）注入当前轮，不依赖会话的 chapterId。会话级 chapterId 仅剩两个用途（跨章路由判断、列表显示章节名），两者都是本次要移除的。

## 2. 决策摘要

| 决策点              | 结论                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| 新会话创建时机      | **纯手动**——同书内永续当前活跃会话，仅「新对话」按钮新建（ChatGPT 模式）          |
| `chapterId` 列去留  | **彻底删除**（表重建迁移），`ConversationDto` 判别联合随之消失（清掉 MA4 遗留债） |
| 会话列表 item       | **单行**：标题 + 相对时间，删章节名副标签                                         |
| 跨重启连续性        | **恢复最近会话**——打开书时该书 `updatedAt` 最新的会话自动成为活跃会话             |
| 「新对话」按钮      | **显式创建空会话**（落库一条 `title: null` 记录），空会话合法                     |
| `routeConversation` | **彻底删除**——send 必传 `conversationId`，只校验不分配                            |
| 新增 UI 入口        | 不加。复用 AIPanel header 既有「+」按钮，仅改其行为                               |

## 3. 数据模型与迁移

### schema 变更（`src/main/db/schema.ts`）

- `conversations` 删除 `chapter_id` 列，其余列不动。
- 该列带 FK（references `chapters`），SQLite 删带 FK 的列需**表重建**，`pnpm db:generate` 自动生成迁移。

### 迁移风险与验证

- `messages` 有 FK 指向 `conversations`，表重建是已知坑场景（drizzle `migrate()` 包事务内 PRAGMA 切 FK 是 no-op）；`runMigrations` 已在事务外切 `foreign_keys=OFF`，理论上已防御。
- **必须用带真实会话数据的既有 dev 库验证迁移**（`:memory:` 新建库测不出表重建撞子表 FK 的问题）：迁移后既有会话与消息数据完整保留，仅丢弃 chapterId。

## 4. 共享契约（`src/shared/chat.ts`、`src/shared/ipc.ts`）

- `ConversationDto`：判别联合（`kind: "chapter" | "independent"`）还原为**普通 interface**——`id`、`bookId`、`assistantId`、`title`、`createdAt`、`updatedAt`。`kind` 与 `chapterId` 字段删除。
- `createConversationInput`：收窄为 `{ bookId: string }`。
- `ai.send` 入参（`SendInput`）：`activeConversationId?`（可选）改为 **`conversationId: string`（必传）**，Zod schema 同步收紧。`currentChapterId` **保留**——它服务于「当前轮注入当前章摘要」，属于消息级上下文，与会话归属无关。

## 5. 主进程行为

### 删除 `routeConversation`（`src/main/chat/conversations.ts`）

整个函数及其测试删除。它存在的前提（「会话只能在发消息时隐式创建」）已被「按钮显式创建空会话」取代——发消息时永远有明确目标会话，隐式分配器失业。

### `ai.send`（`src/main/ai/send.ts`）

- 只**校验**不分配：`conversationId` 对应会话必须存在且 `bookId` 匹配，否则抛带通道名的可读错误（透传给 renderer，不默默新建）。
- 标题派生时机：从「route 新建时」改为「**首条消息落库时，若会话 `title` 仍为 null 则 `deriveConversationTitle`**」——按钮建的空会话在收到第一条消息时拿到标题。
- 其余链路不变：段落去重、chips 快照入 `metadata.contextChips`、章节摘要按 `currentChapterId` 仅注入当前轮。

### `createConversation` 防堆积

若该书已存在**零消息**会话，直接返回最新的那个而不新建——连点 N 次「新对话」不会堆 N 个「未命名会话」。

## 6. Renderer

### chat-store（`src/renderer/store/chat-store.ts`）

- 删 `activeConversationChapterId` 及配套逻辑；`setActiveConversation(id)` / `openConversation(id)` 简化为单参数。

### 打开书时恢复最近会话

- 打开书时，**仅当 store 中 active 为空或不属于该书**，用现有 `conversationsListByBook` 查询取 `updatedAt` 最新的会话装入 active；active 已有且同书则保留用户当前选择，不覆盖。
- 该书从无会话时 active 保持 **null**——不预创建，避免只读不问的书长出空会话。

### 发送路径（`AIPanel.tsx` 的 `handleSend` 及 transport）

- 发送时 active 为 null → 先 `conversationsCreate({ bookId })` 拿 id 设为 active → 再 send（send 必传 `conversationId`）。
- `handleSend` 内「跨章自由输入防御」分支（清面板那段）整体删除；ack 回写纠正 active 的机制简化（发送前 conversationId 已确定）。
- `use-ai-actions.ts` 内「跨章划词清 active」判别块整体删除。

### 「新对话」按钮（AIPanel header 既有「+」）

行为从「清面板 + active 置 null」改为：`conversationsCreate({ bookId })` → `setActiveConversation(newId)` → 清空消息区。防堆积由主进程兜底。

### AIPanel header 第二行

现显示「章节名 · 会话」（取会话归属章，回退当前阅读章）——「会话归属章」语义消失。改为显示**活跃会话标题**（fallback「未命名会话」；无活跃会话时整行隐藏）。会话可跨章后，用户需要知道「正在续哪个会话」，标题比章节名更准确。
（注：此处为推断默认，spec 审阅时可调整。）

## 7. 会话列表 UI（`ConversationsTab`）

- item 改**单行**：标题（fallback「未命名会话」）+ 相对时间；章节名副标签删除。
- 「独立会话」标签随判别联合一起消失，所有会话一视同仁。

## 8. 测试与验证

### 主进程

- 删 `routeConversation` 测试。
- 新增：`createConversation` 复用空会话（防堆积）；send 拒绝不存在/跨书 `conversationId`；首条消息落库补 derive title；空会话第一条消息后标题生效。

### 迁移

- `:memory:` 单测覆盖新 schema；另需**手动用带数据的 dev 库**（`--user-data-dir` 隔离副本）跑迁移冒烟：迁移成功、会话与消息数据完整。

### Renderer

- chat-store 测试更新签名；恢复最近会话逻辑补测试（有会话取最新 / 无会话保持 null / 切书重算）。

## 9. 影响面清单

| 层       | 文件                                      | 变更                                  |
| -------- | ----------------------------------------- | ------------------------------------- |
| schema   | `src/main/db/schema.ts` + 新迁移          | 删 `chapter_id` 列（表重建）          |
| 共享契约 | `src/shared/chat.ts`、`src/shared/ipc.ts` | DTO 去判别联合；create/send 入参变更  |
| 主进程   | `src/main/chat/conversations.ts`          | 删 `routeConversation`；create 防堆积 |
| 主进程   | `src/main/ai/send.ts`                     | 校验代替路由；标题派生时机调整        |
| renderer | `store/chat-store.ts`                     | 删 `activeConversationChapterId`      |
| renderer | `ai/AIPanel.tsx`                          | 按钮行为、header 副行、删跨章防御     |
| renderer | `ai/use-ai-actions.ts`                    | 删跨章判别块                          |
| renderer | `reader/ConversationsTab.tsx`             | 单行 item                             |
| renderer | 开书流程（reader 挂载处）                 | 恢复最近会话                          |

## 10. 非目标

- 不做会话删除/归档功能（空会话防堆积已缓解垃圾问题）。
- 不做「按章节过滤会话」（未来如需可从消息级 `contextChips` 派生）。
- 不动章节摘要机制（仍按当前阅读位置注入当前轮）。
- 不做跨书全局会话（会话仍归属单一 book）。
