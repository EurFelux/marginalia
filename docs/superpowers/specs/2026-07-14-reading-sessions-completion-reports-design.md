# 阅读轮次与完成阅读报告设计

日期：2026-07-14  
状态：已确认
关联需求：GitHub Issue #78

## 背景

Marginalia 目前用 `books.isFinished` 表示一本书是否读完。这个布尔值只能描述书的当前状态，无法表达同一本书被多次阅读，也没有明确的开始、完成时间或每次阅读各自留下的成果。

现有的全书摘要回答“这本书讲了什么”。本需求引入另一种完成阅读的仪式：当读者结束一次阅读时，生成并保留一份 Markdown 报告，重点记录阅读过程中读者思考了什么、判断如何变化、建立了哪些联系，以及最终想留下什么。

## 目标

- 让“开始阅读”和“完成阅读”成为明确、可感知的操作。
- 支持同一本书被阅读多次，每次阅读拥有独立的时间范围与报告。
- 保留现有按天和按书的活跃阅读时长统计，并能进一步按阅读轮次统计。
- 由独立的报告 agent 按需读取读者痕迹、书籍内容和长期记忆，以助手观察读者的视角生成报告。
- 让报告体现用户当前设定的助手人格与写作指令，并在完成阅读时整理值得长期保留的读者记忆。
- 让普通聊天 AI 能在之后按需读取已有报告。
- 在模型失败、材料不足或用户暂时不想生成时，完成阅读本身仍然可靠成立。

## 产品原则

1. **报告属于读者，不是另一份书摘。** 全书内容概括继续由全书摘要承担；完成报告围绕读者的疑问、判断、连接和收获组织。
2. **事实来自痕迹。** Agent 不虚构读者的感受或变化。材料不足的章节应省略，而不是补齐模板。
3. **完成与生成解耦。** 点击完成后立即结束本次阅读；报告可现在生成、稍后生成或完全手写。
4. **一次阅读是一等实体。** 报告、开始时间、完成时间和该轮次的活跃时长都属于 reading session，而不是直接属于 book。
5. **Markdown 是报告的持久化真相源。** 不另外持久化报告章节、引用来源、工具调用轨迹或版本历史。
6. **报告由认识读者的助手书写。** 默认由助手以第一人称直接面向读者，当前人格、用户指令和长期记忆共同塑造报告；长期理解必须与本轮直接痕迹明确区分。
7. **旧稿在新稿成功前始终安全。** 重新生成是显式确认后的替换操作；生成期间继续展示旧稿，用户可以停止任务，只有完整成功的新稿才会替换旧稿。

## 非目标

- 不自动检测进度达到 100% 并完成阅读。
- 不把书籍内容、完整报告或一次性想法写入全局记忆。
- 不允许报告 agent 删除长期记忆或修改助手人格。
- 不复制或永久绑定标注、笔记、消息到某个 reading session。
- 不保存报告生成时的证据清单或 provenance。
- 不提供同一 session 内的报告版本历史。
- 不为没有任何阅读痕迹的升级前旧书虚构 reading session。
- 以“打开正文参考”方式阅读时不计时，也不写阅读进度。

## 领域模型

### `reading_sessions`

新增表：

```text
reading_sessions
- id            TEXT PRIMARY KEY         // uuidv7
- book_id       TEXT NOT NULL            // FK books(id), ON DELETE CASCADE
- started_at    INTEGER NOT NULL
- completed_at  INTEGER NULL
- report        TEXT NULL                 // Markdown
```

数据库约束：

- 每本书最多存在一个 `completed_at IS NULL` 的 session，使用 partial unique index 保证。
- `CHECK (completed_at IS NULL OR completed_at >= started_at)`，完成时间不能早于开始时间。
- `CHECK (report IS NULL OR completed_at IS NOT NULL)`，进行中的阅读不能提前拥有完成报告。
- `completed_at` 为空表示进行中，非空表示已完成；不增加冗余 `status` 列。

### 书籍状态

移除 `books.isFinished`，从 session 派生书籍状态：

| 条件                                         | 状态   |
| -------------------------------------------- | ------ |
| 没有任何 session                             | 未开始 |
| 存在 `completed_at IS NULL` 的 session       | 阅读中 |
| 至少一个已完成 session，且没有进行中 session | 已完成 |

这个状态只描述书籍当前所处阶段；历史完成次数来自已完成 session 数量。

### 阅读时长

现有 `reading_daily` 继续作为唯一的活跃时长事实表。新增可空列：

```text
reading_session_id TEXT NULL
  REFERENCES reading_sessions(id)
  ON DELETE SET NULL
```

其新数据粒度为“书籍 × 阅读轮次 × 本地日期”。迁移时移除原有 `(book_id, day)` unique index，并对 `reading_session_id IS NOT NULL` 的行建立 `(reading_session_id, day)` partial unique index；否则同一本书在同一天开始第二次阅读时无法产生独立记录。新发生的计时都必须归属当前 active session。

`reading_session_id IS NULL` 只保留给没有可归属 session 的历史（例如书或关联 session 已删除）。升级时，每本有阅读痕迹的旧书都会获得一个 legacy session，且它的旧 `reading_daily` 行全部回填到该 session。NULL 行不再承担 upsert 目标，因此不需要新的 unique 约束；按日和按书查询仍对所有匹配行求和。

同一批事实支持三种聚合：

- 按日期汇总：全局每日阅读时长。
- 按 `book_id` 汇总：一本书的生命周期总阅读时长。
- 按 `reading_session_id` 汇总：一次阅读的活跃时长。

完成阅读时先 flush 当前阅读时钟，再写入 `completed_at`，避免最后一段时间落入下一次阅读。删除 session 后，其 daily 记录的 session 外键置空；删除 book 后，session 和报告级联删除，但 `reading_daily.book_id` 与 `reading_session_id` 均置空，从而继续保留全局阅读历史。

## 状态与操作流程

### 首次开始

没有 session 的书籍打开后进入轻量的开始页，而不是直接进入正文。用户点击“开始阅读”后：

1. 在事务中创建 active session，记录 `started_at`。
2. 进入正文阅读器。
3. 后续阅读计时写入该 session。

升级前已经存在阅读进度的书籍不生成虚假 session。用户第一次显式开始时，继续从原有保存位置阅读。

### 完成阅读

阅读中的书籍可显式执行“完成阅读”：

1. Flush 阅读时钟。
2. 为 active session 写入 `completed_at`。
3. 立即将书籍状态派生为已完成。
4. 进入完成页，并邀请用户“现在生成报告”或“稍后再说”。

报告生成失败不会回滚完成状态。

### 已完成书籍

从书库打开已完成书籍时，默认进入完成页并展示最近一次 session。用户可以切换历史 session，并执行：

- **打开正文参考**：只读式进入正文；不创建 session、不启动阅读时钟、不写进度。
- **再读一次**：在同一事务中创建新的 active session，并将阅读进度重置到开头，然后进入正常阅读器。

### 阅读中的书籍

从书库打开存在 active session 的书籍时，直接继续当前阅读进度。

## 完成页

采用独立的完成/报告页面，而不是对话界面。页面包含：

- 书籍封面与基本信息。
- 当前 session 的开始日期、完成日期、经过天数和活跃阅读时长。
- session 历史选择器，默认选中最近一次。
- Markdown 报告主区域，支持预览与编辑。
- 根据状态展示生成、重新生成、保存、重试等操作。
- “打开正文参考”和“再读一次”入口。

已有报告的“重新生成”必须先弹出确认框，明确成功后会替换当前报告。用户确认后，旧报告继续展示，主操作变为 destructive 语义的“停止重新生成”；初次生成时也提供同样视觉语义的“停止生成”。停止是正常用户动作：立即回到由持久化内容派生的 `ready` 或 `empty` 状态，不显示失败提示。重新生成成功后自动替换旧稿，不增加候选稿确认、撤销或版本历史。

生成结果是由助手以第一人称直接写给读者的可编辑草稿，例如“我注意到你……”。不强制助手署名或提及自己的名字。章节结构根据证据灵活选择，例如“反复出现的问题”“发生变化的判断”“建立的连接”“想带走的东西”；没有证据的章节不输出。用户指令可以覆盖默认视角、结构和内容偏好。

## 共享契约

### 报告运行时状态

报告状态必须用 Zod discriminated union 表达，避免把内容可空性和松散的状态联合塞在同一个 DTO 中：

```ts
const nonEmptyMarkdownSchema = z.string().trim().min(1);

const readingReportStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("generating") }),
  z.object({
    status: z.literal("generation-failed"),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("ready"),
    content: nonEmptyMarkdownSchema,
  }),
  z.object({
    status: z.literal("regenerating"),
    content: nonEmptyMarkdownSchema,
  }),
  z.object({
    status: z.literal("regeneration-failed"),
    content: nonEmptyMarkdownSchema,
    reason: z.string(),
  }),
]);
```

Session 详情 DTO 形如：

```ts
{
  session: ReadingSession;
  report: ReadingReportState;
}
```

渲染层对 `status` 做穷尽分支。运行中的状态存在于主进程内存，不写入数据库；应用重启后，有报告回到 `ready`，无报告回到 `empty`。

### 主要操作

共享 IPC 契约应覆盖以下领域操作，具体通道命名遵循现有 `src/shared/ipc.ts` 风格：

- 开始阅读。
- 完成当前阅读。
- 列出一本书的 sessions。
- 读取 session 详情及报告状态。
- 生成或重新生成报告。
- 停止当前报告生成任务。
- 保存用户编辑后的 Markdown。

开始阅读的输入也用判别字段明确区分两种语义，避免用多个可选布尔值组合状态：

```ts
const startReadingInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("continue"), bookId: bookIdSchema }),
  z.object({ mode: z.literal("restart"), bookId: bookIdSchema }),
]);
```

`continue` 创建 session 但保留当前进度，用于首次开始和迁移后继续旧进度；`restart` 创建 session 并将进度归零，只用于已完成书籍的“再读一次”。数据库 partial unique index 是并发请求的最终防线。

报告生成命令的同步响应同样是 discriminated union：接受任务时返回 `accepted`；预检发现没有读者痕迹时返回 `insufficient-evidence`。后者不是运行时失败状态，不会把报告状态改成 `generation-failed`。

停止命令也返回 discriminated union：确实终止当前任务时返回 `canceled`；session 当前没有生成任务时返回 `idle`。重复停止必须幂等。停止命令不删除或修改持久化报告，也不写入失败状态。

读系统时间属于 Electron 胶水层；纯业务函数接收注入的 `Temporal.Instant` 或 `Temporal.ZonedDateTime`，以便测试不依赖机器时区。

## 报告生成 agent

### 模型与职责

报告使用当前配置的摘要模型，不使用聊天模型。它是独立 agent loop，不创建 conversation/message。摘要模型缺失、不支持工具调用或调用失败时，返回明确错误；不静默降级到聊天模型。

每次生成和重新生成都实时读取当前的助手人格、用户指令、记忆开关和记忆索引，不使用普通聊天按 conversation 冻结的上下文快照。普通聊天的快照和缓存行为保持不变。人格自然影响助手的观察方式与表达习惯，但报告不强制署名。用户指令是报告写作层面的最高优先级，可以覆盖默认视角、结构和内容要求；事实边界、目标 session 范围和工具权限等技术约束不可覆盖。

Agent 可以自行决定只读摘要，还是进一步读取正文。书籍内容用于理解上下文，读者痕迹才是判断“读者想过什么”的依据。

### 工具能力

报告 agent 可按需调用：

- 书籍元数据、目录与全书摘要。
- ePub 章节正文或 PDF 页面文本。
- 当前 session 时间窗口内的标注。
- 当前 session 时间窗口内的书籍笔记。
- 当前 session 时间窗口内的历史对话。
- 该书以前的阅读 sessions 与报告。
- 当前 session 的活跃阅读统计。
- 当前启用的长期记忆索引，以及按 slug 读取完整记忆。
- 新增长期记忆，或更新已有长期记忆。

目标 `bookId` 和 `sessionId` 由主进程在创建工具集时闭包绑定，不让模型任意指定其他书籍；工具参数只暴露当前目标范围内必要的章节、页码、会话或历史 session 选择。Agent loop 设置有限的最大步骤数，并沿用现有正文读取工具的输出上限，避免无限工具循环或把整本书一次性塞进上下文。

报告使用专用记忆工具集，只包含 `readMemory`、`saveMemory` 和 `updateMemory`，不包含 `deleteMemory` 或 `updateSoul`。关闭 `memoryEnabled` 时不注入记忆索引，也不提供任何记忆工具；助手人格和用户指令仍然生效。Agent 只保存值得跨会话延续的读者偏好、观点、反复出现的概念、思考框架、修正和跨书连接；书籍事实继续由书摘承载。遇到语义相近的条目时，应先读取并更新既有记忆，而不是创建重复条目。记忆正文沿用现有语言、slug 和双向链接约定。

工具默认以目标 session 的时间窗口过滤证据：`started_at <= timestamp <= completed_at`。

- 标注和笔记在窗口内创建或更新，即视为本轮痕迹。
- 对话列表返回窗口内存在消息的会话；读取时只返回窗口内且位于 conversation compact 边界之后的原始消息，并可补充理解该段对话所需的相邻上下文。
- 以前的报告必须由 agent 显式读取，不默认塞入 prompt。
- 全书摘要、目录和正文不受 session 时间范围限制。

#### 长会话与 compact 边界

历史对话可能远长于报告 agent 的上下文预算。`readConversation` 必须遵守现有 conversation compaction 的持久边界：

- 永远不返回 `seq <= summarizedThroughSeq` 的原始消息，哪怕这些消息位于目标 reading session 的时间窗口内。
- 存在 `contextSummary` 时返回该滚动摘要及其 `throughSeq`，并明确标记为压缩背景。滚动摘要可能包含本次阅读开始前的讨论，不能冒充本轮逐条直接证据。
- 原始消息只从 `seq > summarizedThroughSeq` 的尾部选取，再应用 reading session 时间窗口；相邻上下文也不得跨越 compact 边界。
- 如果本轮涉及的消息已经全部被压缩，返回摘要和“没有可用原始尾部消息”的类型化结果，不重新读取旧消息。
- 即使会话尚未 compact，也不一次性返回全部原始消息。工具使用游标分页并限制单次结果的文本预算；超长单条消息必须显式标记截断，agent 可按需继续读取后续页。

工具结果必须区分压缩背景、当前 session 原始消息和相邻上下文，避免 agent 把不同证据等级混为一谈。

### 生成前检查

生成前先检查是否至少存在一种读者痕迹：标注、笔记或对话。若完全没有痕迹：

- 不调用模型。
- 返回类型化的“材料不足”结果。
- 保持现有持久化报告不变，运行时状态仍为 `empty` 或 `ready`。
- UI 解释原因，并允许用户打开空白 Markdown 编辑器手写。

扫描版 PDF 无可提取正文并不等同于材料不足；只要存在读者痕迹，agent 仍可生成。

### 提示词约束

系统提示词要求：

- 默认由助手以第一人称自称、以第二人称称呼读者，撰写直接面向读者的可编辑草稿。
- 应用当前助手人格和用户指令，不强制署名；用户指令可以覆盖默认写作视角、结构和内容偏好。
- 关注读者在阅读过程中的问题、判断、变化、联系和保留物。
- 不把全书摘要改写成报告主体。
- 任何关于读者心理或观点的判断都必须能由痕迹支持。
- 证据不足时省略对应内容，不虚构完整性。
- 可以比较以前的阅读报告，但要明确这是跨轮次的变化，而不是本轮原始痕迹。
- 可以用长期记忆解释或连接本轮痕迹，但必须用“结合我过去对你的了解”等语义明确标识为跨期理解，不能声称它是在本轮直接观察到的事实。
- 只把稳定、可跨会话复用的读者信息写入长期记忆；先检查相近记忆并优先更新，不保存书籍内容、完整报告或一次性想法。

### 原子性与并发

- 同一 session 同时只允许一个生成任务，主进程按 session ID 去重或拒绝重复请求。
- 每次任务由主进程持有独立 `AbortController`，其 signal 传给报告 agent 和模型调用；停止命令先令 generation 失效，再调用 `abort()`，确保与完成回调竞态时迟到结果也不能落库。
- 每次生成创建一个临时记忆工作区。`readMemory` 同时读取数据库快照和本轮已暂存的变化；`saveMemory`、`updateMemory` 只暂存操作，不在模型调用途中直接修改数据库。
- 初次生成期间不持久化 partial Markdown；模型成功产出非空报告、且该 generation 仍是当前任务后，在同一数据库事务中保存报告并提交暂存的记忆操作。
- 重新生成时保留并展示旧报告，暂时锁定编辑；成功后在同一事务中原子替换报告并提交记忆操作，失败后继续保留旧报告和旧记忆。
- 生成失败、被更新的 generation 取代或记忆提交冲突时，丢弃整个临时记忆工作区，不留下不可见的半成品记忆。
- 用户停止生成时同样丢弃临时记忆工作区；模型因该 signal 抛出的 abort 不记录为生成失败，也不留下失败横幅或错误 toast。
- 页面关闭不取消后台任务；应用退出则任务自然终止。因运行状态不持久化，重启后由数据库内容恢复为 `empty` 或 `ready`。
- 模型、网络、工具等错误必须留下包含原始错误的 `warn` 日志，并只向 UI 返回可理解、不泄漏内部细节的失败原因。

用户显式保存编辑后，保存的 Markdown 立即成为权威报告，但手工编辑不反向改写长期记忆。重新生成仍需用户主动触发，并在新的 agent loop 中重新读取当前人格、指令和记忆。

## 普通聊天 AI 读取报告

在 reader 和 library 两种 AI 上下文中注册两个只读工具：

```text
listReadingSessions(bookId)
  -> session id、开始/完成时间、活跃时长、是否有报告

getReadingReport(sessionId)
  -> 该 session 的元数据与当前 Markdown
```

两步式工具避免把一本书所有历史报告自动注入上下文。`getReadingReport` 必须验证 session 与可访问书籍的关系，避免跨书泄漏。

## 主进程架构

保持“主进程厚、渲染层薄”：

- `reading-sessions`：纯业务与仓储函数，负责创建、完成、状态派生、列表和报告保存。
- `reading-daily`：继续负责唯一计时事实，增加 session 归属和按 session 聚合。
- `reading-report`：生成前检查、实时 agent 上下文、agent loop、证据工具、临时记忆工作区、运行时状态、并发控制和原子写入。
- IPC handler：注入 DB、当前时间、模型配置和运行时依赖。
- renderer：只根据共享 DTO 展示开始页、阅读器或完成页，并发起显式操作。

报告 agent 的工具应复用现有摘要、阅读、标注、笔记、消息和统计领域函数，避免从 renderer 取数据或复制查询逻辑。

## 数据迁移

迁移执行以下变更：

1. 创建 `reading_sessions` 及其约束和索引。
2. 为 `reading_daily` 增加可空 `reading_session_id`，调整唯一约束为新粒度。
3. 删除 `books.isFinished`。

升级策略：

- 为每本有旧阅读痕迹的书创建一个真实 legacy session，并把其旧 `reading_daily` 行关联到该 session；没有任何阅读痕迹的书不创建 session。
- `started_at` 优先取该书最早的 message 时间；没有 message 时才从 progress、标注、笔记、会话和按日计时的最早可用时间兜底。`is_finished` 为真时，`completed_at` 取不早于开始时间的最晚可用痕迹时间；否则保留 active session。
- 在 Drizzle 生成的 DDL 前，以私有持久 staging 表快照 legacy 候选和 uuidv7 session id；DDL 后在一个事务中插入 session、回填全部 legacy daily FK 并删除 staging。staging 已存在时复用，故 staging 后 DDL 前、DDL 后 post-apply 前、以及 post-apply 事务内中断均可在下次启动恢复，且不重复创建。
- staging 兼容完成标记加入前、按日计时加入前和书籍笔记加入前的真实历史 schema：只有尚未创建 `reading_sessions` 的旧库才重新采集；每个痕迹来源均在对应表和时间列存在时才查询。完成标记尚不存在时，采集到的 session 视为 active；已完成当前迁移、没有 staging 的库不会重复采集。
- 保留旧阅读进度、标注、笔记、对话和全书摘要。

迁移文件必须由 `pnpm db:generate` 生成，不手写。

## 测试策略

### 数据库与领域测试

- 每本书最多一个 active session。
- 同一本书可连续拥有多个 completed session。
- active session 不能保存报告，completed session 可以。
- 删除 book/session 时符合级联与 `SET NULL` 约定。
- 书籍三态派生正确，不依赖冗余布尔值。

### 计时测试

- 同一本书同一天的两个 session 各自拥有 daily 行。
- 全局、按书、按 session 聚合分别正确且不重复计数。
- 完成前 flush 的最后一段时间归属旧 session。
- 参考模式不启动时钟、不写进度。
- 删除关联 session 或已删除书留下的 `reading_session_id = NULL` 历史仍计入全局和按书统计；有阅读痕迹的 legacy daily 行在升级后不保留 NULL。

### 报告状态与生成测试

- 覆盖 discriminated union 的六种运行时状态。
- 初次生成失败不留下 partial report。
- 重新生成失败保留旧报告。
- 应用重启后的状态只由持久化报告恢复。
- 证据工具按 session 时间窗口过滤。
- 对话证据不返回 compact 边界以前的原始消息；存在滚动摘要时仅作为有明确标记的压缩背景返回。
- 未 compact 的长会话按游标分页并受单次文本预算限制；完全 compact、边界邻居和单条消息截断均有覆盖。
- Agent 可选择读取旧报告或正文，但默认 prompt 不预加载它们。
- 默认提示词采用助手视角，并在每次生成时读取最新人格和用户指令；普通聊天的 conversation 快照行为不变。
- 开启记忆时只提供读取、新增、更新工具；关闭记忆时索引和工具同时消失，删除记忆与修改人格始终不暴露给报告 agent。
- 成功生成时报告与暂存记忆在同一事务中保存；生成失败、过期或提交冲突时两者均保持原状。
- 重生成可读取并更新已有记忆，也能在临时工作区中读取本轮刚暂存的变化。
- 零读者痕迹时不调用模型，并允许手写报告。
- 初次生成和重新生成都可真正中止模型调用；停止后分别恢复 `empty` 与保留旧稿的 `ready`，不会进入失败态。
- 取消与生成完成竞态时，被取消 generation 的报告和暂存记忆均不能提交。
- 用户编辑保存后，聊天 AI 立即读到新内容。

### AI 工具测试

- `listReadingSessions` 只返回指定书籍的 session 摘要。
- `getReadingReport` 返回指定 session 的 Markdown 和元数据。
- 不允许用某本书的上下文读取其他书的 session。

### UI 与端到端验收

- 未开始、阅读中、已完成三种书籍分别路由到正确页面。
- 完成确认、生成失败、稍后生成和手写路径均可用。
- 重新生成前必须确认；生成期间可停止，停止重新生成后旧报告保持不变且没有失败提示。
- 完成页默认展示最近 session，并可切换历史。
- “打开正文参考”不改变 session、时间或进度。
- “再读一次”创建新 session 并重置进度。
- 手工走通：开始阅读 → 产生计时与痕迹 → 完成 → 生成并编辑报告 → 聊天 AI 读取报告 → 再读一次 → 同日产生第二轮时长 → 生成第二份报告并比较两轮变化。

## 验收标准

1. 用户能显式开始、完成和再次开始一本书，且每次阅读拥有独立 session。
2. 旧的按日/按书时长统计保持正确，新 session 时长可准确查询。
3. 完成阅读不依赖 AI 成功，也不会因生成失败而回滚。
4. 报告围绕读者痕迹生成、可编辑、按 session 永久保存。
5. 普通聊天 AI 能通过工具按需读取任意已有报告。
6. 有痕迹的旧书迁为一个真实 legacy session，且不丢失旧进度、痕迹或阅读时长。
7. 所有运行时报告状态通过 discriminated union 表达，渲染层可以穷尽处理。
8. 报告默认由当前人格的助手直接写给读者，遵循用户指令，并能在不产生半成品状态的前提下读取、创建和更新长期记忆。
9. 报告读取长会话时绝不重新载入 compact 边界以前的原始消息，未压缩尾部也受分页和单次文本预算约束。
10. 重新生成只有在用户确认且完整成功后才替换旧稿；初次生成和重新生成均可真正停止，停止不会改变报告或记忆，也不会被呈现为失败。
