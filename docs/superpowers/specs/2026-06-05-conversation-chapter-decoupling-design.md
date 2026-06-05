# Conversation 与 Chapter 解耦设计

日期：2026-06-05
状态：已与用户对齐，待实现

## 1. 背景与动机

当前会话模型是**章节粒度**：`conversations.chapterId` 绑定单一章节（NULL = 「独立会话」），`routeConversation` 在用户跨章划词提问时强制新建会话。实际使用反馈：

- **阅读体验是连续的**，跨章自动新建会话直接打断会话连续性——读到下一章想接着问上一个问题，被迫从零开始；
- 会话 tab 每个 item 显示章节名副标签，**占用空间**且信息价值低；
- 章节摘要由主进程在 send 时**隐式注入**当前轮，用户不可见也不可控——与选区/段落 chips 的「所见即所得」模型不一致。

关键洞察：上下文锚定其实已经是**消息级**的——每条 user 消息的选区/段落 chips 快照存于 `metadata.contextChips`；章节摘要按「当前阅读位置」（`input.currentChapterId`）注入当前轮，不依赖会话的 chapterId。会话级 chapterId 仅剩两个用途（跨章路由判断、列表显示章节名），两者都是本次要移除的。

## 2. 决策摘要

| 决策点              | 结论                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 新会话创建时机      | **纯手动**——同书内永续当前活跃会话，仅「新对话」按钮新建（ChatGPT 模式）                                                                     |
| `chapterId` 列去留  | **彻底删除**（表重建迁移），`ConversationDto` 判别联合随之消失（清掉 MA4 遗留债）                                                            |
| 会话列表 item       | **单行**：标题 + 相对时间，删章节名副标签                                                                                                    |
| 跨重启连续性        | **恢复最近会话**——打开书时该书 `updatedAt` 最新的会话自动成为活跃会话                                                                        |
| 「新对话」按钮      | **显式创建空会话**（落库一条 `title: null` 记录），空会话合法                                                                                |
| `routeConversation` | **彻底删除**——send 必传 `conversationId`，只校验不分配                                                                                       |
| 新增 UI 入口        | 不加。复用 AIPanel header 既有「+」按钮，仅改其行为                                                                                          |
| 摘要注入方式        | **chip 化**——章节/全书摘要改为 ChipBar 常驻 toggle chip，用户显式控制，主进程不再隐式注入                                                    |
| 摘要 chip 默认态    | 默认 **off**；「将开启新会话」状态预设 **on**；发送成功后回落 off（一段对话只输入一次）                                                      |
| 会话标题            | **废除 userText 截断 derive**，改为 **auto naming**——首轮完整对话后 AI 异步起名（落 ROADMAP backlog「自动命名会话」）；null 期间走 i18n 占位 |

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
- `ai.send` 入参（`SendInput`）：`activeConversationId?`（可选）改为 **`conversationId: string`（必传）**，Zod schema 同步收紧。`currentChapterId` **删除**——它原本仅服务「路由 + 摘要隐式注入」，路由已删、摘要 chip 化（§6）后无任何读取方；「章节」概念至此完全退出对话子系统。
- `chipIdSchema`（`src/shared/types.ts`）：扩为四元 `["selection", "paragraph", "chapter-summary", "book-summary"]`——live Chip 与持久化快照共用单一来源，自动覆盖两侧。
- `chipSchema` 状态收敛（落 `src/shared/chat.ts:13` 的 MA5 TODO）：`required: boolean` + `enabled: boolean` 两个独立 bool 收敛为三态闭合联合 **`state: "required" | "on" | "off"`**——非法组合（`required && !enabled`）在类型层消失。选区/段落 chip 构建为 `required`；摘要 chip 为 `on`/`off`。

## 5. 主进程行为

### 删除 `routeConversation`（`src/main/chat/conversations.ts`）

整个函数及其测试删除。它存在的前提（「会话只能在发消息时隐式创建」）已被「按钮显式创建空会话」取代——发消息时永远有明确目标会话，隐式分配器失业。

### `ai.send`（`src/main/ai/send.ts`）

- 只**校验**不分配：`conversationId` 对应会话必须存在且 `bookId` 匹配，否则抛带通道名的可读错误（透传给 renderer，不默默新建）。
- **摘要隐式注入删除**：`getChapterSummaryView` 调用、`prompt.ts` 的 `chapter: { title, summary }` 特殊参数及对应组装分支整体删除——摘要随 chips 统一链路进入消息（§6），prompt 组装的输入只剩「system + 历史（各带自己的 chips）+ 当前轮 chips + 正文」，上下文来源完全同构，无隐藏注入通道。
- 其余链路不变：段落去重、chips 快照入 `metadata.contextChips`。

### `createConversation` 防堆积

若该书已存在**零消息**会话，直接返回最新的那个而不新建——连点 N 次「新对话」不会堆 N 个「未命名会话」。

### 会话自动命名（取代 derive）

- `deriveConversationTitle`（首条 userText 截断起名）**废除**——它本是 auto naming 就位前的占位实现；`setConversationTitle` 写入路径保留，即为 auto naming 的接口。
- **触发**：一轮 send 完成、assistant 消息以 `complete` 落库后，若会话 `title` 仍为 null → 异步触发命名（fire-and-forget，不阻塞流结束）。规则天然覆盖边角：首轮 assistant error/aborted 不触发，下一轮 complete 后用该轮上下文重试；写回后 title 非 null，不再触发。
- **上下文与模型**：取触发轮的 user + assistant 两条消息；复用会话 assistant 的已解析模型做一次非流式短调用；产出简短标题（语言跟随对话内容），写回 `setConversationTitle`。
- **失败处理**：模型未配置/调用失败 → title 保持 null（UI 走 i18n 占位），错误落日志不打扰用户——与自动摘要触发侧的静默取向一致，绝不编造标题。
- **UI 感知**：会话列表对「有消息但 title=null」的会话短轮询直到写回（复用 summary-queries 的非终态轮询工厂模式，缓存命中不启轮询的坑已知），具体形态实现计划定。

## 6. 摘要上下文 chip 化

### 常驻 toggle chips

- ChipBar 常驻两个摘要 chip：「章节摘要」（`chapter-summary`，跟随当前阅读章）与「全书摘要」（`book-summary`）。瞬态的选区/段落 chips 仍随划词出现。
- 点击切换 on/off；`state: "off"` 的 chip 发送前由 renderer 过滤，不进 send 入参。
- 全书摘要至此**首次获得进入对话的能力**（此前仅书卡查看，从未注入 prompt）。

### 状态机

- 默认 **off**。
- 「将开启新会话」状态预设 **on**：点「新对话」按钮后，或打开书发现无任何会话（active=null）时——新会话首条消息自动带背景，落实「一段对话只输入一次摘要」。（注：active=null 预亮是对「新对话按钮预设 on」的推广，让隐式新会话同样受益，且用户发送前可见可关。）
- 发送成功后回落 off；重开历史会话不预亮。

### 未生成摘要的处理

- 用户**手动**点 on 且摘要未生成 → 触发生成（显式意图，复用现有 generate IPC 与轮询），chip 显示生成中状态。
- **自动**预设 on 不触发生成——不默默花 token，呼应 autoSummarize 默认关的取向。
- 发送时摘要仍未 ready → 该 chip 跳过不入快照（不阻塞发送），保持 on，生成完成后随下一条消息带上。

### chip 构建与水合

- 摘要 chip 的 content 为发送时的摘要文本快照（自包含），token 估算复用主进程 `estimateTokens`（IPC 形态——扩展 `ai:build-chips` 或新增轻通道——实现计划定）。
- 摘要日后重新生成不影响已发送消息中的旧快照（快照语义，对话记录可追溯）。
- 历史水合（`message-history.ts`）：labelKey 由 id 反推扩展两个新 id；历史 chip 一律水合为 `state: "required"`（落库即已发送，不可交互）。

### 与 SummaryPill 的分工

SummaryPill（与侧栏书卡）仍是摘要的**查看/生成**入口，职责不变；常驻 chip 是**对话注入控制**。两者读同一份 summary query 数据。

## 7. Renderer

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

行为从「清面板 + active 置 null」改为：`conversationsCreate({ bookId })` → `setActiveConversation(newId)` → 清空消息区 → **摘要 chips 预设 on**（§6 状态机）。防堆积由主进程兜底。

### AIPanel header 第二行

现显示「章节名 · 会话」（取会话归属章，回退当前阅读章）——「会话归属章」语义消失。改为显示**活跃会话标题**（fallback「未命名会话」；无活跃会话时整行隐藏）。会话可跨章后，用户需要知道「正在续哪个会话」，标题比章节名更准确。
（注：此处为推断默认，spec 审阅时可调整。）

## 8. 会话列表 UI（`ConversationsTab`）

- item 改**单行**：标题 + 相对时间；章节名副标签删除。
- title 为 null 时显示 i18n 占位 `reader.conversation.untitled`（key 已存在，zh「未命名会话」/ en "Untitled conversation"）；「title 空退章节标题」分支删除。
- 「独立会话」标签随判别联合一起消失，所有会话一视同仁。

## 9. 测试与验证

### 主进程

- 删 `routeConversation` 测试。
- 新增：`createConversation` 复用空会话（防堆积）；send 拒绝不存在/跨书 `conversationId`。
- auto naming：title null + assistant `complete` 落库 → 触发；error/aborted 轮不触发；命名失败 title 保持 null；title 非 null 不再触发。
- chips：三态收敛后构建/快照投影/段落去重测试更新；prompt 组装测试删「章节摘要注入当前轮」分支，确认摘要以 chip 形态与其他 chips 同构组装。

### 迁移

- `:memory:` 单测覆盖新 schema；另需**手动用带数据的 dev 库**（`--user-data-dir` 隔离副本）跑迁移冒烟：迁移成功、会话与消息数据完整。

### Renderer

- chat-store 测试更新签名；恢复最近会话逻辑补测试（有会话取最新 / 无会话保持 null / 切书重算）。
- 摘要 chip 状态机测试：默认 off / 新会话预设 on / 发送后回落 off / 未 ready 跳过且保持 on。
- 历史水合测试：两个新 chip id 的 labelKey 反推。

## 10. 影响面清单

| 层       | 文件                                                             | 变更                                                              |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| schema   | `src/main/db/schema.ts` + 新迁移                                 | 删 `chapter_id` 列（表重建）                                      |
| 共享契约 | `src/shared/types.ts`、`src/shared/chat.ts`、`src/shared/ipc.ts` | DTO 去判别联合；create/send 入参变更；chip id 四元；chip 三态收敛 |
| 主进程   | `src/main/chat/conversations.ts`                                 | 删 `routeConversation`；create 防堆积                             |
| 主进程   | `src/main/ai/send.ts`                                            | 校验代替路由；删摘要隐式注入；接 auto naming 触发                 |
| 主进程   | `src/main/chat/conversation-title.ts`                            | 删 `deriveConversationTitle`，改造为 auto naming 模块             |
| 主进程   | `src/main/ai/prompt.ts`                                          | 删 `chapter` 特殊参数及组装分支                                   |
| 主进程   | `src/main/ai/chips.ts`                                           | 三态收敛；摘要 chip 构建/token 估算                               |
| renderer | `store/chat-store.ts`                                            | 删 `activeConversationChapterId`；摘要 chip 状态机                |
| renderer | `ai/AIPanel.tsx`                                                 | 按钮行为、header 副行、删跨章防御                                 |
| renderer | `ai/ChipBar.tsx`、`ai/Composer.tsx`                              | 常驻摘要 toggle chips                                             |
| renderer | `ai/use-ai-actions.ts`                                           | 删跨章判别块                                                      |
| renderer | `ai/message-history.ts`                                          | 水合扩展两个新 chip id                                            |
| renderer | `reader/ConversationsTab.tsx`                                    | 单行 item                                                         |
| renderer | 开书流程（reader 挂载处）                                        | 恢复最近会话                                                      |

## 11. 非目标

- 不做会话删除/归档功能（空会话防堆积已缓解垃圾问题）。
- 不做「按章节过滤会话」（未来如需可从消息级 `contextChips` 派生）。
- 不动摘要的**生成与查看**机制（SummaryPill 弹卡、侧栏书卡、generate IPC 与轮询均不变；变的只是进入对话的方式）。
- 不做跨书全局会话（会话仍归属单一 book）。
