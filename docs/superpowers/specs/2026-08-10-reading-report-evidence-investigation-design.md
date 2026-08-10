# 阅读报告证据调查 · 设计文档

> 状态：已实现（本文在实现中同步修订，与代码一致）。
> 日期：2026-08-10
> 关联：`2026-07-14-reading-sessions-completion-reports-design.md`（本文修正的证据获取链路即由该轮引入）。

## 背景与目标

生成阅读报告时，AI 拿到的会话历史明显只是全部内容的一小部分。排查发现这不是单一缺陷，而是**四道互相叠加的闸门**，且模型对自己"没读完"这件事完全无感知：

1. **步数上限过紧**：`agent.ts` 的 `stopWhen: isStepCount(10)`。10 步要装下 `listAnnotations` / `listBookNotes` / `listConversations` / 若干次 `readConversation` / 可能的 `readMemory` 加上最后写正文。只要会话多于两三个，翻页就会在写正文前被截停。
2. **模型不知道要翻页**：`READING_REPORT_CORE` 通篇只讲报告的写法与边界，一个字都没提分页；user prompt 只有一句 `Inspect reader traces before writing.`。`readSessionConversation` 返回的 `hasMore` / `nextAfterSeq` 机制本身完备，但没人告诉模型要用。
3. **单次预算的单位不一致**：`SESSION_CONVERSATION_TEXT_BUDGET = 24_000` 的单位是**字符**，而 `estimateTokens` 对 CJK 是 1 字符 = 1 token。同一个数字在中文下约等于 24k token，在英文下只有约 6k token——**行为差 4 倍**。
4. **模型对会话规模一无所知**：`listSessionConversations` 只返回 id / title / 时间戳。模型无法预算，只能盲目翻页直到步数耗尽。

另有一项事实约束影响了方案选择：`contextSummary` **大多数会话都是 null**。`context-compaction.ts` 的 `TAIL_TOKENS_HIGH = 100_000` 意味着只有尾轮超 100k token 的会话才会被压缩。"很长但没到 100k"的会话——比如 60k token、上百条消息——完全没有摘要可用，而这正是痛点最集中的区间。因此"靠 contextSummary 防止 context 爆炸"这条路无法独立成立。

**目标**：让报告 agent 能完整覆盖一次阅读的全部会话证据，同时自身 context 保持可控。

**成功判据**：

1. 一次阅读中的**每个会话都被检视过**，不存在"步数耗尽导致整段会话从未被读取"的情况。
2. 主 agent 的 context 占用**不随单个会话的长度线性增长**——长会话由 subagent 消化后回传要点。
3. 主 agent 能**深挖**：subagent 回传的每条要点可回溯到原文片段，细节取舍权不被 subagent 封顶。
4. 用户的后台并发设置对新增的模型调用**真实有效**，不被绕过。
5. subagent 的任何失败都**软降级**，不使报告生成失败。

**验证方式**：证据层与 investigator 走 vitest 纯函数单测（注入 fake runner）；覆盖完整性走真实长会话手测。

## 范围

**在范围内**：

- `src/main/reading-report/` 的证据工具面、agent 编排、system prompt。
- `service.ts` 中报告生成与全局后台限流池的关系。

**不在范围内**：

- **不调整压缩阈值**。`TAIL_TOKENS_HIGH = 100_000` 保持不变——subagent 已接管长会话，无需靠压缩来救；调低它会改变主对话本身的行为，属另一件事的射程。
- **标注与笔记的取数逻辑不变**。`listSessionAnnotations` / `listSessionBookNotes` 数据量小，不构成瓶颈。
- **时间窗过滤不变**。`evidence.ts` 中"消息 `createdAt` 须落在 session 窗口内、前后各补一条 neighbor"的规则经确认无问题。

## 架构

主 agent 从"自己读完一切"改为**编排者**：掌握全局视野与预算，小会话自己读，大会话外派 subagent，需要原话时回头深挖。

```
主 agent (generateText, 摘要模型, 40 步)
  ├─ listConversations        → 带规模元数据的清单，据此做预算
  ├─ readConversation         → 小会话直读 / 深挖回溯（24k token/次）
  └─ investigateConversation  → 大会话外派
        └─ subagent（摘要模型，逐页单发）
              └─ 循环分页读完单个会话（40k token/页，总上限 150k token）
              └─ 每页单独抽要点，只让要点跨页累积
              └─ 回传结构化要点 + 每条要点的 seq 范围
```

### 组件一：`evidence.ts` — `listSessionConversations` 补规模元数据

现有返回值追加三个字段：

- `messageCount` — 本 session 窗口内的消息条数
- `estimatedTokens` — 对窗口内消息正文调 `estimateTokens`（`@shared/tokens`，`context-compaction.ts` 已在用）
- `hasCompactedContext` — 该会话是否有非空 `contextSummary`

主 agent 第一步即可看到"3 个会话：2k / 8k / 62k"，据此分配预算。

### 组件二：`investigator.ts`（新文件）— subagent 逻辑

纯函数 + 注入端口（`readPage` 读一页证据、`generate` 单发模型），不碰 Electron，可 headless 单测。生产侧的组装（绑定 db / session / 模型 / 并发额度）放在 `investigation-runner.ts`，使 `investigator.ts` 保持无 IO。

职责：对单个会话循环分页读取（每页 40k token，累计上限 150k token），逐页交给摘要模型抽取要点，最后合并。

**刻意不做成"给 subagent 一套翻页工具、让它自己循环"**：那样每页原文都会累积进 subagent 自己的上下文，长会话照样爆——只是把爆点从主 agent 挪到 subagent，成功判据 #2 只兑现了一半。逐页抽取则只让**要点**跨页累积，单次模型调用的上下文恒等于「一页 + 已确立的 topic」，与会话总长度无关。代价是模型看不到跨页的长程关联，由「已确立的 topic」与主 agent 手上的全局视野补偿。

因此 subagent 不是 tool-calling loop，无需 `stopWhen`；页数由预算和 `hasMore` 决定。

输出形态：

```ts
{
  topic: string,
  points: Array<{
    kind: "question" | "judgment" | "turn" | "connection",
    text: string,
    quote: string | null,
    seqFrom: number,
    seqTo: number,
  }>,
  coverage: {
    fromSeq: number | null,   // 未读到任何原始消息（如全部落在压缩前缀之后为空）时为 null
    toSeq: number | null,
    messagesRead: number,
    truncated: boolean,
  },
}
```

`seqFrom` / `seqTo` 是**可回溯性**的载体：主 agent 认为某条要点值得读者的原话时，用 `readConversation({ afterSeq: seqFrom - 1, limit })` 回去读那一段。这些 seq 仅在工具往返中流转，与现有 `nextAfterSeq` 同性质，不进报告正文——`READING_REPORT_CORE` 的内部标识禁令不受影响。

累计读取触及 150k 上限时 `coverage.truncated: true`，如实上报给主 agent，由它决定是否补读。

### 组件三：`tools.ts` — `investigateConversation` 工具

入参 `{ conversationId: string, focus?: string }`。负责注入依赖、走全局 `runBackground`、把 investigator 的结果翻译成三态：

- `{ status: "ok", ...investigation }`
- `{ status: "busy", suggestion: "read this conversation directly with readConversation" }` — 45s 内未拿到并发槽位
- `{ status: "failed", suggestion: 同上 }` — subagent 抛错 / 模型未配置 / 输出不合 schema

**派不派由主 agent 决定，不设代码闸门**。工具描述里给一条软指引（估算超 ~30k token 的会话建议外派），但不硬编码阈值。

### 组件四：并发归属的修正

现状 `service.ts` 把整个报告生成流程包进 `runBackground`，占用**全局后台并发池**的一个槽位，且在查 DB、跑工具、等模型思考的全程都攥着它。这有两个问题：subagent 若也走该池会**自锁**（外层持槽等内层，内层永远排队）；而给 subagent 开独立池又会让**用户的并发设置形同虚设**。

根因是归属错了：报告生成是用户在 UI 上显式点击、有进度反馈、可取消的**前台任务**，与聊天同级，本不该与"后台自动摘要"抢同一个池。

改法：

- **主 agent 不再走 `runBackground`**，直接跑。
- **subagent 走全局 `runBackground`**，用户的并发设置对它完全有效。
- 嵌套消失，自锁随之消失；持槽的只有 subagent，各自会完成并释放。

顺带修复一个现存问题：报告生成不再长时间阻塞章节摘要等真后台任务。

**已知副作用**：多个 session 同时生成报告时，主 agent 之间不再互相限流。实际影响很小——`runtime` 的 claim 是 per-session，用户须在多本书上分别点"生成"才能触发。

**busy 降级的正当性**：用户把并发调成 1、且正在跑章节摘要时，subagent 排队拿不到槽位而返回 busy、主 agent 转为自己翻页——这正是用户调低并发时期望的行为，而非被独立池偷偷绕过。

### 为什么不采用"向主 agent 暴露槽位计数"

曾考虑让主 agent 查询并发池余量、有空位才外派。否决理由：

1. **TOCTOU**——模型看到的数字到它真正发出调用时已隔一次推理往返，可能已过期，基于会腐坏的数字做计划必然出错。
2. **降级方向反了**——池忙时让主 agent 自己硬读 62k 会话，恰是本设计要防的 context 爆炸。池忙时它应该等。
3. **诱发保守**——模型见槽位紧张会"懂事"地少派，本该外派的也自己读了。

改为通过**调用结果**暴露池状态：主 agent 拿到的是已发生的事实而非预测，且是在它已读完其他会话、清楚自身 context 余量的时刻做降级决定，判断质量更高。

## 预算与步数

预算**记账单位从字符改为 `estimateTokens`**（截断仍按字符切），使中英文行为一致，并与 `context-compaction.ts` 对齐。

| 项                          | 现在     | 改后           | 理由                                                                                                                   |
| --------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 主 agent `stopWhen`         | 10 步    | **40 步**      | 不去掉——去掉后模型卡在翻页循环里就失去兜底。40 步足够"列清单 + 派 3 个 subagent + 深挖几段 + 写正文"，同时构成失控上限 |
| `readConversation` 单次预算 | 24k 字符 | **24k token**  | 数值不动，只统一单位。主 agent 用它读小会话和回溯片段，此粒度合适                                                      |
| subagent 单页预算           | —        | **40k token**  | subagent 的 context 只装一个会话，可以吃得更粗                                                                         |
| subagent 累计上限           | —        | **150k token** | 读到底或读到此上限，触顶则 `coverage.truncated: true`                                                                  |
| subagent 槽位等待超时       | —        | **45s**        | 超时转 busy 降级                                                                                                       |

## Prompt

`READING_REPORT_CORE` **不变**——它管报告的写法与边界，掺入调查方法论会稀释它。

新增 `REPORT_INVESTIGATION_GUIDANCE`，与 `REPORT_MEMORY_GUIDANCE` 并列插入 `buildReadingReportSystemPrompt`，位置在 memory 指引**之前**：

> ## Investigating this reading
>
> Start with listConversations, listAnnotations, and listBookNotes to see the full scope before reading anything in depth. Each listed conversation reports its size; use that to budget. Read a small conversation directly with readConversation, paging with nextAfterSeq while hasMore is true. For a large conversation, call investigateConversation instead of paging it yourself — it returns the reader's questions, judgments, and turning points with the message range each came from. When a returned point deserves the reader's own words, read that range directly. If investigateConversation reports busy or failed, page the conversation yourself and prefer breadth over completeness. A conversation with compacted context offers a background summary — read it first to orient, then decide which stretches to read closely. Do not begin writing while any listed conversation remains uninspected; if evidence is incomplete, say less rather than guessing.

末句是对本次缺陷的直接补丁——原 prompt 从未把"还有未读内容"表述为一个模型应当在意的状态。

`agent.ts` 的 user prompt 只改半句：`Inspect reader traces before writing.` → `Inspect all reader traces before writing; conversation evidence is paginated.`

## 错误处理

- **subagent 一切失败均软降级**，绝不使报告生成失败：抛错 / 模型未配置 / 输出不合 schema → 返回 `status: "failed"` 并留 `log.warn`（遵循"凡优雅吞错处必须留 warn"）。
- **槽位超时**同理返回 `status: "busy"`。落点是 `background-limiter.ts` 新增的 `acquireSlot(run, timeoutMs)`：占位任务体只等 release，故超时分支同样调 release——该占位若稍后才被调度会立即结束，不真正消耗额度。
- **abortSignal 透传到底**：用户取消报告生成（`runtime.cancel`）时，在跑的 subagent 必须一并中止，否则产生继续烧配额的孤儿请求。现有代码无此先例，需显式接线。

## 测试

- `evidence.test.ts` — `listSessionConversations` 三个新字段（含有 `contextSummary` 的会话），以及 token 记账：同长度的 CJK 被截断而拉丁文本不被截断，外加可覆盖的 `tokenBudget`。
- `investigator.test.ts`（新增）— 注入 fake `readPage` / `generate`：分页读完并合并要点、**每次模型调用不夹带前页原文**、累计预算触顶置 `truncated: true`、单页预算被剩余总预算夹住、越界 seq 被夹回本页、单页解析失败跳过而其余保留、全页失败才抛错、compacted-only 直接收尾、focus 透传。
- `background-limiter.test.ts` — `acquireSlot` 的授予/释放与超时放弃（含放弃后不残留占用）。
- `tools.test.ts` — ok / busy / failed 三条路径与 focus 透传。
- `prompt.test.ts` — 新指引段的存在性，以及 memory 关闭时它仍在。
- 覆盖完整性（每个会话都被检视）走真实长会话手测。

## 实现落点

| 文件                                              | 变化                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/shared/tokens.ts`                            | 新增 `sliceToTokenBudget`（按 token 记账、按字符截断）                                    |
| `src/main/ai/structured-output.ts`                | 新增；从 `memory-consolidation.ts` 抽出 `extractJsonObject` + `parseJsonOutput`，两处共用 |
| `src/main/ai/background-limiter.ts`               | 新增 `acquireSlot`                                                                        |
| `src/main/reading-report/evidence.ts`             | 规模元数据；预算改 token 并可覆盖                                                         |
| `src/main/reading-report/investigator.ts`         | 新增；纯逻辑的分页调查                                                                    |
| `src/main/reading-report/investigation-runner.ts` | 新增；接真实模型与并发额度                                                                |
| `src/main/reading-report/tools.ts`                | `investigateConversation` 工具与三态降级                                                  |
| `src/main/reading-report/service.ts`              | 主 agent 脱离后台池；注入 investigator                                                    |
| `src/main/reading-report/agent.ts`                | `REPORT_AGENT_MAX_STEPS = 40`；user prompt 补半句                                         |
| `src/main/reading-report/prompt.ts`               | `REPORT_INVESTIGATION_GUIDANCE`                                                           |
