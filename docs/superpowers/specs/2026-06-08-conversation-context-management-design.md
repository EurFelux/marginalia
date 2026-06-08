# Marginalia · 会话上下文管理（rolling summary + 逐字尾轮）设计文档

> 状态：设计已确认（用户认可，待落实施计划）
> 日期：2026-06-08
> 轨道：AI 会话质量——把「每轮重发全量历史」改为「后台滚动概要 + 最近逐字尾轮」，给长会话的 prompt 套一个上界，遏制超长上下文导致的模型走神/丢焦点。
> 需求：GitHub Issue [#64](https://github.com/EurFelux/marginalia/issues/64)（`enhancement` · `area:ai` · P1）。
> 上游取证：2026-06-08 排查「工具调用常常失败」时定性——非静默错误，是模型行为；详见记忆 `ai-toolcall-failure-is-model-behavior`。

---

## 0. 问题陈述（取证结论）

`src/main/ai/send.ts` 每轮发送都把**整条会话历史**重发给模型：`runSend` 第 3 步 `history = listMessages(db, conversationId)` 取全部既往消息，`assemblePrompt`（`src/main/ai/prompt.ts`）把每条 user/assistant 轮渲染进 prompt（assistant 轮经 `textOfParts` 只取文本）。prompt 体量随会话轮数**线性无界增长**。

2026-06-08 实测一条 **124 条消息**的会话（《早起的奇迹》整本边读边聊）：模型逐渐**退化成纯闲聊模式、不再发 tool_call**，甚至幻觉谎称已调用工具。三层取证（dev 日志 / 裸 HTTP 代理 / headless SDK replay）确认传输链路、代理、`@ai-sdk/openai-compatible` 全部正常——根因是**超长纯文本历史**把模型带偏（叠加该模型在含糊提问上 tool-calling 本就不稳）。

当前无任何窗口化 / 截断 / 摘要机制，长会话的 token 成本、延迟、模型质量都随轮数恶化。本 spec 聚焦**质量与可靠性**（用户明确的核心目的），通过给 prompt 套上界来缓解。

## 1. 目标与非目标

**目标**：长会话发送时，prompt = `system（含滚动概要）` + `逐字尾轮` + `当前轮`，使 prompt 体量有界；早期讨论要点经**滚动概要**保留（用户在读什么、表达过的观点/偏好、该记住的事实），不被整段丢弃。绝大多数会话保持全量逐字，仅马拉松级会话才触发压缩。

**非目标**：

- **不改** `textOfParts` 对 assistant 历史 tool-call/tool-result part 的回放行为（缓办的「改模型行为」，#64 之外单独追踪）。
- **不引入**真 tokenizer——沿用 `@shared/tokens.ts` 的 `estimateTokens` 粗估。
- **不**把概要回填进 `messages` 表（不污染对话真相源）。
- **不**做发送时同步压缩（已否决方案 B：会给用户消息叠加数秒延迟、迫使 `assemblePrompt` 变 async/不纯）。
- **不**做纯滑动窗口（已否决方案 C：丢失早期讨论，不满足「保住要点」）。

## 2. 核心模型与 prompt 形态

**核心不变式**：一次发送的 prompt =

```
system（助手提示词 + PDF 注 + 滚动概要块）
└─ 逐字轮：seq > summarizedThroughSeq 的既往消息
└─ 当前轮（readingContext + chips + userText，不变）
```

**两个新概念（挂在 conversation 上）**：

- `contextSummary`：滚动概要文本，把「早期已折叠轮」压缩成一段。
- `summarizedThroughSeq`（记作 `S`）：概要已覆盖到的最大消息 `seq`。**概要覆盖 `seq ≤ S`，逐字保留 `seq > S`**。`null` = 一轮都没折叠 → 退化为现状全量逐字。

**概要放进 `system`**（非历史消息流）：语义上是「助手应当 ground 的权威背景」，且 `system` 本由 `assemblePrompt` 产出 messages[0]、`send.ts` 抽出经 `system:` 传入——顺现有管线、不新增机制。概要只在后台压缩时变化（罕见，见 §4），prompt-cache 抖动可控（已与用户确认接受）。

## 3. 数据模型与 `assemblePrompt`/`runSend` 接线

改动收敛在 4 处，均顺现有结构：

**① DB schema（`src/main/db/schema.ts`，`conversations` 表加两列）** — 改后跑 `pnpm db:generate` 生成迁移（drizzle-orm 1.0-rc 子目录格式，勿手编）：

- `context_summary` TEXT，nullable，默认 `null`。
- `summarized_through_seq` INTEGER，nullable，默认 `null`。

**② `assemblePrompt`（`src/main/ai/prompt.ts`，保持纯函数）** — 加入参 `priorSummary: string | null`。仅当非空时，把概要拼进 system 内容：

```
systemPrompt + "\n\n## Conversation summary so far\n" + priorSummary
```

`history` 入参语义收窄为**只含逐字尾轮**（调用方按 `seq` 过滤后传入）——`assemblePrompt` 自身不碰 `S`，职责单一、依旧好测。

**③ `messages.ts` 新增查询** `listMessagesAfterSeq(db, conversationId, afterSeq: number | null)`：`afterSeq` 为 `null` 取全量（等价现状），有值取 `seq > afterSeq` 的尾轮——避免把上百条历史全捞进内存。

**④ `runSend` 接线（`src/main/ai/send.ts`）**：

- 现第 1b 步 `select({ bookId })` 扩成同时取 `contextSummary` + `summarizedThroughSeq`。
- 第 3 步 `history = listMessages(...)` 改为 `listMessagesAfterSeq(db, conversationId, S)`。
- 把 `contextSummary` 作为 `priorSummary` 传给 `assemblePrompt`。
- **取数时序无变**：仍在「落本轮 user 消息之前」取历史（现第 3 步先于第 4 步）。

## 4. 后台压缩任务

**新模块** `src/main/ai/context-compaction.ts`（纯核心 + 注入依赖，headless 可测），照搬 `src/main/ai/summary.ts` 范式：模块级 in-flight 去重集 + fire-and-forget。

**触发**：`send.ts` 的 `toUIMessageStream` `onFinish` 内、`status === "complete"` 时，紧挨现有 `nameConversation` 调一发 `void maybeCompactConversation(deps, conversationId)`——**每轮完成都检查预算，仅超高水位才真摘要**（否则 no-op）。并发去重防同会话重复压缩。放在「轮后」而非「下次发送前」，使概要在用户下条消息发出时已就绪 → **零额外发送延迟**（方案 A 的命门）。

**预算（双水位 + 最近轮地板）**，全为具名常量、标注可调：

- 尾轮 = `seq > S` 的消息，按 `assemblePrompt` 同款渲染（user 轮带 chips via `renderUserTurn`、assistant 轮 `textOfParts`）后用 `estimateTokens` 估算。
- **高水位**（触发）：尾轮估算 > `TAIL_TOKENS_HIGH` = **100_000**。
- **低水位**（压缩目标）：从最老的**完整 user→assistant 对**起折叠，直到尾轮 ≤ `TAIL_TOKENS_LOW` = **10_000**。
- **最近轮地板**：永远至少保留 `MIN_RECENT_TURNS` = **20** 条逐字（= 10 轮对话），压缩绝不吃进最近交流。与低水位取「保留更多」者——若最近 20 条本身 > 10k，地板优先、不再多折。
- 折叠只在**对话对边界**，`S` 推进到最后折叠的 assistant `seq`。
- 估算跑在**渲染后文本**上（reasoning 已被 `textOfParts` 排除），反映真实 prompt 体量而非臃肿的存储 parts。

> 100k→10k 大间距意味着压缩**罕见但一次到位**：绝大多数会话从不触发、保持全量逐字，仅马拉松级会话压缩一次性折叠到 ~10k。契合质量优先。

**增量再摘要**：`newSummary = summarize(summaryModel, oldSummary, 折叠轮转写)`。

- 提示词维护一段滚动概要：捕获*用户在读什么、表达过的观点/偏好、决定、助手该记住的事实*，去寒暄；输入分 `Previous summary:`（首次为空）+ `New exchanges:`。
- `maxOutputTokens` = `SUMMARY_MAX_TOKENS` = **4096** → 每次重压成定长，**概要自身长度有界**。
- 模型复用 `resolveSummaryModel`（与章节/全书摘要、自动命名同源）。

## 5. 错误处理与降级

核心原则：**压缩永不阻塞发送、永不损坏会话**。

- 压缩模型调用失败/超时 → `log.warn`，概要与 `S` 原样不动，尾轮多留一会儿，下轮再试（优雅降级）。
- 摘要模型未配置（`resolveSummaryModel` 返回 `!ok`）→ 整个压缩跳过，会话退回全量逐字（现状），留一条 warn。
- 会话压缩中途被删 → 落库前 check-then-act 丢弃（同 send/summary 既有守卫；better-sqlite3 同步驱动，回调内 check-then-act 安全）。
- 概要写入是单条同步 better-sqlite3 写，失败 `log.warn`、不影响后续发送。
- 日志域用 `summary`（与既有摘要管线同域，便于 grep）；级别遵循项目规范（吞错处必留 warn）。

## 6. 范围边界（落实施时严守）

- 不改 `textOfParts` 的 tool-call/result 回放（#64 之外单独追踪）。
- 不引入真 tokenizer——`estimateTokens` 粗估，留「日后可换精确分词」注释钩子。
- 概要不回填 `messages` 表，仅作派生上下文存 `conversations` 两列——呼应「ModelMessage 按需派生、不持久化」的既有哲学。
- 不触碰渲染层：本机制全在主进程，UI 无感（用户看到的历史气泡仍是 `messages` 表全量，概要纯属发送侧的 prompt 派生）。

## 7. 测试策略（headless vitest，`:memory:` SQLite）

- `assemblePrompt` 带 `priorSummary`：纯单测——概要进 system、`priorSummary=null` 时 system 不变、仅尾轮渲染。
- 压缩核心（注入假 summarizer）：折叠选取在预算/地板下的正确性、`S` 推进到 assistant 边界、双水位 + 地板交互（含「最近 20 条 > 10k 时地板优先、不再多折」用例）、尾轮未超高水位时 no-op。
- `listMessagesAfterSeq`：`afterSeq=null` 取全量、有值取尾轮、空尾轮。
- 降级：摘要模型未配置 → 跳过且不抛、会话保持全量逐字；summarizer 抛错 → 概要/`S` 不变 + warn。
- 集成：构造跨过 100k 的会话 → 压缩后概要落库、`S` 推进、后续 `runSend` 组装出「概要 + 尾轮」。

## 8. 可调常量汇总

| 常量                 | 值      | 含义                                         |
| -------------------- | ------- | -------------------------------------------- |
| `TAIL_TOKENS_HIGH`   | 100_000 | 尾轮估算超此值触发压缩                       |
| `TAIL_TOKENS_LOW`    | 10_000  | 压缩目标：折叠到尾轮 ≤ 此值                  |
| `MIN_RECENT_TURNS`   | 20      | 最少逐字保留的消息条数（地板，优先于低水位） |
| `SUMMARY_MAX_TOKENS` | 4096    | 滚动概要单次再摘要的输出上限                 |

均为模块级具名常量，集中定义、便于日后调参。

## 9. 关联

- 需求 issue：[#64](https://github.com/EurFelux/marginalia/issues/64)。
- 取证记忆：`ai-toolcall-failure-is-model-behavior`（本机制的直接动机；其中「`textOfParts` 剥历史 tool part」的副作用属缓办项，不在本 spec）。
- 既有范式参考：`src/main/ai/summary.ts`（in-flight 去重 + fire-and-forget + `resolveSummaryModel`）、`src/main/chat/conversation-title.ts`（轮后 fire-and-forget 自动命名）。
- 设计哲学：`src/main/ai/prompt.ts` 头注「历史与当前同构、无隐藏注入通道」「ModelMessage 按需派生不持久化」。
