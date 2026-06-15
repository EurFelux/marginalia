# 后台记忆整理 pass + main→renderer 通知通道设计（issue #91）

日期：2026-06-16
状态：设计中（待实现）
关联：#91（Periodically consolidate AI memory in the background）
前置：`docs/superpowers/specs/2026-06-10-ai-global-memory-soul-design.md`（全局记忆 + SOUL，本设计是对其 §0/§1/§4 决策的有意识修正，见 §10）

## §0 背景与目标

2026-06-10 的记忆系统把记忆完全交给 **inline 工具**（`saveMemory`/`updateMemory`/`readMemory`…），由 AI 在对话中**自主决定**何时记、记什么；该 spec §0/§1 **明确否决了后台提取管线**，理由两条：「难以控制」「与对话脱节」。spec §4 同时承认了一条已知风险：「工具调用积极性依赖模型质量——弱模型可能从不存记忆」。

实践印证了这条风险：**AI 对记忆并不主动**——值得长期记住的事实经常没被存下，已有记忆也无人整理。

**本设计的目标**：在**保留 inline 工具不变**的前提下，加一条**后台补网**——每 N 轮对话在后台跑一次「记忆整理 pass」，既补提取 AI 漏存的持久事实，也顺手巩固（合并近似、精炼）已有记忆。它是补充，不是替换。

**对当初两条否决理由的逐条回应**（详见 §10）：

- 「难以控制」→ 用**结构化单发 + 确定性落库**：一次 LLM 调用产出 Zod 校验过的操作清单，纯函数 apply，不放任自主多步工具循环。
- 「与对话脱节」→ pass 读的就是**该会话最近 N 轮**对话，提取直接锚在对话上。
- 成本顾虑 → **专属开关 `memoryAutoConsolidate`，默认关**（仿 `autoSummarize` 哲学）。

## §1 核心决策总览

| 决策点       | 结论                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| 定位         | inline 工具不动；后台 pass 作补网，不替换                                                 |
| 核心职责     | 补提取（读对话补漏存）+ 顺手巩固（合并近似 / 精炼已有记忆）                               |
| 写入机制     | 结构化单发：`generateObject` 产出操作清单（Zod 判别联合）→ 纯函数 `applyMemoryOps` 落库   |
| 触发         | 每 **N** 轮（常量，默认 5）；挂现有 `streamAssistantReply.onFinish`，紧邻 compaction      |
| 进度水位线   | `conversations.memoryThroughSeq`，镜像 `summarizedThroughSeq`                             |
| 删除约束     | 仅删「已并入他条的冗余副本」；**不删「陈旧」**（守 2026-06-10 §10.2：陈旧只有用户能判断） |
| 模型 / 并发  | 复用 `summaryModel`（与压缩 / 命名 / 摘要同源）+ `runBackground` 限流器                   |
| 门控         | 专属 `memoryAutoConsolidate`（默认 **false**）；且受 `memoryEnabled`（默认 true）总闸约束 |
| 可见性       | 完成且有变更时，main 经 `app:notify` 推**结构化 counts**，renderer 本地化成轻 toast       |
| 通知通道形态 | main 推结构化数据、renderer 本地化（i18n 在 renderer）；判别联合，今天只一个成员          |

## §2 触发与数据流

### 2.1 触发点

挂在现有 `src/main/ai/stream-assistant.ts` 的 `result.toUIMessageStream` 的 `onFinish` 回调、`status === "complete"` 分支，紧邻既有 `maybeCompactConversation` 加一行 fire-and-forget：

```
onFinish (status === "complete")
  → void nameConversation(...)        // 既有：首轮自动命名
  → void maybeCompactConversation(...) // 既有：尾轮超预算时压缩
  → void maybeConsolidateMemory(...)   // 新增：每 N 轮整理记忆
```

与 compaction 并列、互不阻塞，且**永不阻塞发送**（fire-and-forget）。

### 2.2 进度水位线

`conversations` 表新增列，镜像现有 `summarizedThroughSeq`（同为 nullable，初值视作 0）：

```
conversations
└─ memoryThroughSeq  integer("memory_through_seq")  -- 已被记忆 pass 处理到的最后 seq
```

→ 修改 `src/main/db/schema.ts` 后跑 `pnpm db:generate` 生成迁移子目录（**勿手工编辑迁移**）。

### 2.3 触发判定与水位线推进

- **判定**：`seq > (memoryThroughSeq ?? 0)` 的 **assistant 轮数 ≥ N**（常量 `MEMORY_PASS_EVERY_N_TURNS = 5`）才跑。每次 `onFinish` 新增一条 assistant 轮，故大致每 N 轮触发一次。
- **成功推进**：pass 跑完（**含产出空操作**——这几轮确实没料）把 `memoryThroughSeq` 推进到本次处理切片的最新 seq → 计数自然清零。
- **失败保持**：LLM 调用失败 / 摘要模型未配置 / 会话已删 → **不推进**，下一轮带 backlog 重试（自愈）。

### 2.4 pass 的输入

1. **对话切片** = `listMessagesAfterSeq(db, conversationId, memoryThroughSeq ?? 0)` 转写成 `User: … / Assistant: …`（复用 `renderHistoryMessage`，仿 `renderFoldedTranscript`）。
2. **现有记忆全库** = `listMemories(db)`（已返回含 `body` 的完整行）渲染为「slug · title · description · body」清单——巩固需要看到正文才能判断合并 / 精炼。
3. 两段合并后按 char 上限截断（仿 `COMPACTION_INPUT_MAX_CHARS`，超长保留较新内容）。

> 与 compaction 互不干扰：压缩只改「下一轮 prompt 如何渲染历史」、**不删消息**，故 pass 永远能从 DB 读到原始消息；两条水位线各管各的。pass 读不读得到旧轮只取决于自己的 `memoryThroughSeq`。

## §3 写入机制（结构化 + 确定性落库）

### 3.1 操作清单 schema

用 `generateObject`（AI SDK v6）产出 Zod 判别联合操作清单（schema 定义在 `memory-consolidation.ts`，**不跨 IPC、不入 shared**）：

```ts
const memoryOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), slug, title, description, body, reason }),
  z.object({ op: z.literal("update"), slug, title: opt, description: opt, body: opt, reason }),
  z.object({ op: z.literal("delete"), slug, reason }), // 仅限「已并入他条的冗余副本」
]);
const memoryPassOutput = z.object({ ops: z.array(memoryOp) });
```

- `slug` 复用 `@shared/memory` 的 `memorySlug`（kebab-case 校验）。
- `reason`：每条操作一句话理由，仅供 `log.debug` / 排障，不落库。

### 3.2 确定性 apply

纯函数 `applyMemoryOps(db, ops, { sourceBookId }): { saved; updated; deleted }`，**复用现有 repository CRUD**（连带 `syncLinks`/`extractLinks` 边表同步白送）：

- `save` 撞已有 slug → `log.warn` + 跳过（模型眼前有全量索引、本不该撞；且不静默改写既有记忆）。
- `update` / `delete` slug 不存在 → `log.warn` + 跳过（模型对照索引自纠）。
- `sourceBookId` 由主进程从会话 `bookId` 自动填（与 inline `saveMemory` 一致，仅溯源标签）。
- **逐条 try/catch**：单条坏 op 不中断整批；返回三类操作的实际成功计数。

### 3.3 删除约束（守 2026-06-10 §10.2）

后台 pass **不做基于「陈旧」的删除**——记忆是否过时只有用户能判断，系统做不了有意义的事。`delete` 仅用于「内容已并入另一条后清掉冗余副本」这一种场景；prompt 明确约束。基于陈旧的清理仍只走「用户管理面板 + Lia 对话中自主 `deleteMemory`」既有通道。

### 3.4 prompt 要点（实现时打磨）

定位：记忆管理员。从最近对话中提取**尚未被记录**的持久事实（读者偏好、独到观点、反复关注的概念、理解框架、对 agent 行为的纠正）；并巩固现有库（近似条目用 `update` 合并到规范条目、不清晰的精炼）。保守行事；**不因「看起来过时」而删除**。复用 2026-06-10 §3.1 的「该记 / 不该记 / 防重复 / 互链 / 与会话概要分工 / 记忆语言」措辞，保持与 inline 工具指引一致（记忆内容用读者语言，slug 恒英文 kebab-case，body 用 `[[slug]]` 互链）。

## §4 可见性：main→renderer 通知通道

### 4.1 约束与形态选择

后台 pass 是 fire-and-forget，**手上没有发起 `ai:send` 的请求作用域 `sender`**（它深埋在业务层 `streamAssistantReply.onFinish`，业务层不碰 Electron）；且 toast 文案与 i18n 活在 **renderer**（i18next），主进程未初始化 i18next、不应拼本地化文案。

→ 形态：**main 推「结构化数据」，renderer 本地化成 toast**。复用既有 `ai:chunk` 那套 main→renderer 推送范式（`def(..., "event", ...)` + `webContents.send` + preload `on(channel, cb)` + `api.*.on*`）。

### 4.2 通道与载荷

- **新事件通道** `src/shared/ipc.ts`：`appNotify: def("app:notify", "event", z.void(), out<AppNotification>())`。
- **载荷** `src/shared/chat.ts`（与 `AiStreamEvent` 同处）——判别联合，今天**只一个成员**，留扩展口但不预造没人用的字段 / 变体：

```ts
export type AppNotification = {
  kind: "memoryConsolidated";
  saved: number;
  updated: number;
  deleted: number;
};
```

### 4.3 main 胶水层

新 `src/main/notify.ts`：`notifyRenderer(n: AppNotification): void`，用 `BrowserWindow.getAllWindows()` 广播 `webContents.send(C.appNotify.channel, n)`（单窗口 app，广播即发给那一个；`!w.webContents.isDestroyed()` 守卫）。这把通知路径上**唯一的 Electron 触点**收在胶水层。

### 4.4 注入端口（业务层零 Electron）

`SendDeps` 增字段 `notify: (n: AppNotification) => void`；`makeSendDeps()` 生产版填 `notifyRenderer`，测试注入 spy / no-op。`maybeConsolidateMemory` 经 deps 拿到 `notify`，**仅当 `saved + updated + deleted > 0`** 时调一次（零变更不弹，避免每 N 轮空响打扰）。

### 4.5 preload 与 renderer

- `preload-api.ts`：`app.onNotify: (cb: (n: AppNotification) => void) => () => void` ＝ `d.on(C.appNotify.channel, cb)`，返回退订（漂移测试经 `__channel` 走树收集，本通道 `on` 型需在测试中一并覆盖）。
- renderer：App.tsx 内 `<Toaster/>` 旁挂一个一次性订阅（`useEffect` 命令式 subscribe/unsubscribe，清理仍需手写——React Compiler 不接管命令式 effect 清理）。按 `kind` 派发本地化 sonner toast，例：
  `toast(t("memory.consolidated", "Lia 整理了记忆 · 新增 {{saved}} · 更新 {{updated}}", { saved, updated }))`——轻量、auto-dismiss、默认样式（非 success/error）。文案实现时打磨；deleted 计数是否进文案随措辞定。

## §5 模型、并发、门控

- **模型**：复用 `summaryModel`（`resolveSummaryModel`，与压缩 / 命名 / 章摘书摘同源）。结构化受限任务，对弱模型比自主 tool-call 更友好，但提取质量仍依赖模型（接受，见 §7）。
- **并发**：复用 `runBackground` 限流器（与摘要 / 命名 / 压缩共用全局上限）。
- **in-flight 去重**：模块内 `consolidatingConversations: Set<string>`（镜像 `compactingConversations`），重启自然归零；`__resetConsolidationRuntime()` 仅供测试。
- **门控**（双闸）：
  - 新 preference `memoryAutoConsolidate: boolean`，默认 **false**（`src/shared/preferences.ts`；**务必补 `preferences:set` 的 switch case**——已知坑：漏 case 会 IPC 成功但静默不落盘，never 守卫兜底，验证以 sqlite 为准）。
  - 且 `memoryEnabled`（默认 true）为总闸：off 时整个记忆系统隐形，pass 必然不跑。
  - 二者任一为 off → `maybeConsolidateMemory` 早退 no-op。
- N（`MEMORY_PASS_EVERY_N_TURNS`）本期为**模块常量**（默认 5），不做成偏好（YAGNI；观察真实节奏后再议）。

## §6 模块与改动清单

**新增**

- `src/main/ai/memory-consolidation.ts`：常量、op schema、纯函数 `applyMemoryOps` / `renderMemoryPassInput`、编排 `maybeConsolidateMemory`、`__resetConsolidationRuntime`。结构镜像 `context-compaction.ts`。
- `src/main/notify.ts`：`notifyRenderer`（唯一 Electron 触点）。

**修改**

- `src/main/db/schema.ts`：`conversations.memoryThroughSeq` 列 → `pnpm db:generate`。
- `src/shared/preferences.ts`：`memoryAutoConsolidate`（默认 false）+ `preferences:set` switch case。
- `src/shared/ipc.ts`：`appNotify` 事件通道。
- `src/shared/chat.ts`：`AppNotification` 类型。
- `src/main/ai/send.ts`：`SendDeps` 增 `notify` 端口。
- `src/main/ai/send-deps.ts`：`makeSendDeps()` 注入 `notifyRenderer`。
- `src/main/ai/stream-assistant.ts`：`onFinish` 成功分支 +1 行 `maybeConsolidateMemory`。
- `src/preload-api.ts`：`app.onNotify` 订阅器。
- `src/renderer/App.tsx`（或旁挂小组件）：一次性通知订阅 → 本地化 toast。
- `src/renderer/settings/MemorySettings.tsx`：「记忆」版块加 `memoryAutoConsolidate` 开关。
- `src/shared/i18n/locales/*`：toast 文案 + 开关文案 key（改后 `pnpm i18n:extract`）。

## §7 错误处理与边界

- **摘要模型未配置** → `log.warn` + 跳过，不推进水位线（与 compaction 一致）。
- **会话中途被删**：写回前复查会话仍在（better-sqlite3 同步驱动，check-then-act 安全）；不在则丢弃。
- **`generateObject` 失败 / 输出不合 schema** → 捕获、`log.warn`、跳过，不推进水位线（下轮重试）。
- **单条 op 失败**：隔离，不影响整批（§3.2）。
- **空操作**：不发通知，但**推进水位线**（已处理、确认无料）。
- **记忆库空 + 对话切片无料**：pass 正常跑出空 ops，推进水位线，无副作用。
- **弱模型**（接受的已知风险）：可能产出空 ops 或低质 ops；结构化 schema + 确定性 apply 限制了破坏面（撞 slug / 缺 slug 都被跳过），最坏退化为「不整理」，不会污染库。
- **隐私 / 成本**：对话切片与记忆正文仅在该后台请求中发往用户自配 provider；默认关，opt-in 才产生复发成本。

## §8 测试策略（全无头 vitest + `:memory:` DB，纯函数注入）

- `applyMemoryOps`：save 新增 / update 既有 / delete；撞 slug 跳过 + warn；缺 slug 跳过 + warn；body 改动重解析互链（边表同步）；单条坏 op 不中断整批；counts 正确；`sourceBookId` 自动填。
- `renderMemoryPassInput`：确定性、char 上限截断保留较新内容、空库 / 空切片形态。
- 触发与水位线：assistant 轮数 < N 不跑、≥ N 跑；成功推进、空操作也推进、失败不推进。
- 门控：`memoryAutoConsolidate=off` no-op；`memoryEnabled=off` no-op。
- `maybeConsolidateMemory`：注入「返回固定 ops」的假模型 → 落库 + 推进水位线 + 有变更时调一次 `notify`（counts 正确）；注入「失败」的假模型 → warn + 水位线不变 + 不调 notify；零变更 → 不调 notify。
- `preferences:set`：`memoryAutoConsolidate` 落盘（switch case 穷尽性，验证以 sqlite 为准）。
- preload-api 漂移测试：`app.onNotify` 通道纳入收集。

## §9 分期 / 非目标（YAGNI）

**本期**：每 N 轮后台 pass（结构化 + 确定性 apply）+ `memoryThroughSeq` 水位线 + `memoryAutoConsolidate` 开关（默认关）+ `app:notify` 通知通道（一个成员）+ renderer 轻 toast + 设置页开关。

**明确不做**：

- N 做成偏好 / 自适应节奏——本期常量 5，观察后再议。
- 基于「陈旧」的自动删除（守 §10.2）。
- toast 携 action / 点击深链跳记忆设置页——本期纯信息 toast。
- 通知通道的等级 / 变体 / 去重 key / TTL 等——只造唯一消费方需要的字段。
- 跨会话主动联想、`searchMemories`（FTS5）、记忆数量硬上限治理——仍属 2026-06-10 §9 阶段二范畴。

## §10 与既有设计的关系

本设计**有意识地修正** 2026-06-10 spec 的三处：

- §0/§1「无后台提取管线」→ 本期引入后台 pass，但以**结构化 + 确定性 + 默认关**回应当初「难以控制」「成本」顾虑，以**读对话切片**回应「与对话脱节」。
- §4 已知风险「弱模型可能从不存记忆」→ 本期正是针对该风险的补网。

并**严格保留** 2026-06-10 的两处裁决：

- §10.1「AI 保持被动响应、不做主动开场」——本设计是**后台静默整理 + 轻通知**，不改变对话中 Lia 的被动响应姿态。
- §10.2「记忆陈旧只有用户能判断，不做系统性时间衰减」——后台 pass 不删「陈旧」（§3.3）。

inline 记忆工具（`saveMemory`/`updateMemory`/`readMemory`/`deleteMemory`/`updateSoul`）与会话快照冻结、互链边表等 2026-06-10 既有机制**全部不动**。
