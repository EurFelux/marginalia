# 阅读报告改由 agent 调工具落库 — Design

**Issue:** #119
**Date:** 2026-10-03
**Source:** 用户报告（读完《思考，快与慢》后，库里存的报告是一句收尾话）；用户决策 2026-10-03（「换成一个明确的工具调用会更稳定」「让工具做成 db 操作，告知 agent 操作结果」「把报告文本落到 db 这件事，变成 agent 调用工具去做，而不是我们来编排」；提交成功即结束循环，见 §5；「submitReport 严格约束为只有阅读报告 agent 可见和可调用」，见 §3.8）
**前置:** `2026-07-14-reading-sessions-completion-reports-design.md`、`2026-08-10-reading-report-evidence-investigation-design.md`、`2026-08-10-reading-report-progress-feedback-design.md`

## 1. 背景

### 1.1 现象

用户导出的备份 `marginalia-compact-backup-20261003-172602.zip` 里，《思考，快与慢》本次阅读的 `reading_sessions.report` 是：

> 报告已写成。两条新的记忆也存下了：一条关于你对默认选项的立场，一条关于你「幸福是对比出来的」这个分法。上面那份报告是可编辑的，你想改哪一段都行。

它说「上面那份报告」，说明模型其实写出了正文，只是正文没进库。阅读 17:20:28 结束，报告与两条新记忆 17:24:37 在同一事务提交，前后约 4 分钟。

### 1.2 根因

`service.ts` 把 `runReadingReportAgent` 的返回值当报告存库，而它返回的是 `generateText` 的 `result.text`。AI SDK v7 里这个属性**只是最后一步的文字**（源码 `get text() { return this.finalStep.text; }`）。模型在某一步里一边写正文、一边调 `saveMemory`；工具结果回来后它又多说了一句收尾话才停——最后一步只剩这句话，它就被当成报告存了进去。

已用脚本化 mock 模型复现（第 1 步 = 正文 + `saveMemory` 调用，第 2 步 = 收尾话 → 返回收尾话），稳定复现。

### 1.3 为什么不在原路子上修

「取最长的一步」「拼接所有步」都是在猜哪段文字是报告：模型可能在步骤之间夹叙述（「我先看看会话列表」），也可能把正文分两步写。只要报告等于模型的自由文本，就绕不开这种猜测。

## 2. 目标与非目标

**目标**

- 报告正文只有一个明确来源：agent 调 `submitReport` 时传入的 Markdown。agent 的其他文字一概不进库。
- 落库由 agent 调工具完成，工具把操作结果（成功，或失败原因）返回给 agent。我们不再在 agent 跑完后取它的输出去存。
- agent 没有成功提交就结束，本次生成算失败：旧报告保留，暂存记忆丢弃，与现在的「生成失败」一致。
- 保持既有不变量：报告与本次暂存的记忆修改在同一事务提交；已取消或被手动保存顶替的生成不得写库。

**非目标**

- **不处理耗时**。那次的 4 分钟对应约 1092 条消息、约 4.9 MB 的对话证据，主要花在 `investigateConversation` 子 agent 调查上，另议。
- **不修已损坏的那条数据**。修复后用户点「重新生成」即可，也可以手动编辑。
- **不强制 `toolChoice`**。`structured-output.ts` 记载 OpenAI 兼容 provider 对强制工具模式支持参差；靠 prompt 引导 + 结束时检查是否已提交。
- **不改子 agent（investigator）的输出方式**。它走 JSON 文本解析，有结构校验，不受此 bug 影响。

## 3. 方案

### 3.1 `submitReport` 工具（新文件 `src/main/reading-report/submission.ts`）

`createReadingReportSubmission({ signal, commit })` 返回 `{ tools: { submitReport }, submitted(): boolean }`，与 `memory-workspace.ts` 的 `{ tools, mutations }` 同形。

入参 `{ markdown: string }`。按顺序判断：

| 情形                                     | 结果                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本次已成功提交过                         | 返回 `{ saved: false, error: "the report has already been submitted" }`                                                                                     |
| `markdown` 去空白后为空                  | 返回 `{ saved: false, error: "the report is empty; submit the complete Markdown report" }`                                                                  |
| 生成已取消或被顶替（`signal` 已中止）    | 抛出中止错误，不 commit、不记 warn。这是预期的竞态，agent 循环本身也会随中止结束                                                                            |
| `commit` 抛错（DB 错误、记忆乐观锁冲突） | 返回 `{ saved: false, error: "saving failed and retrying will not help: <原因>" }`，记 `log.warn`。明说重试无用，免得模型拿同一个必然失败的调用把 40 步耗光 |
| 成功                                     | 返回 `{ saved: true, hint: "The report is saved and shown to the reader. Your task is complete." }`                                                         |

只允许成功一次：成功即本次生成结束（3.2），第二次提交没有意义；要改报告，用户在 UI 里编辑或重新生成。

### 3.2 `commit`：工具实际做的 DB 操作（service 注入）

service 构造 `commit(markdown)` 闭包：

1. `runtime.isCurrent(session, generation)` 为假 → 抛错。这是防御：正常情况下 `signal` 已先拦下（取消和手动保存都会中止 controller）。
2. 同一事务里：`saveReadingReportInTransaction` + `applyReadingReportMemoryMutations(暂存修改)`。
3. 事务成功后：关闭记忆工作区（3.4），然后 `runtime.succeed(session, generation)`。

`succeed` 放在工具里，报告一落库 UI 就切到「已完成」，不用等 agent 后续步骤。此后这一轮 agent 剩下的进度事件与写操作全部失效——进度出口与 `isCurrent` 都按 generation 判断，是现成机制。

### 3.3 service 的变化

- **之前**：`content = await runAgent(...)` → `.then` 里开事务存 `content` 与记忆 → `succeed`。
- **之后**：`await runAgent(...)`（改为返回 `void`）→ 若 `submission.submitted()` 为假，抛出 `reading report agent finished without submitting a report` → 走既有 `.catch` → `runtime.fail`。`.then` 不再写库。
- 提交成功后，agent 在后续步骤出错（网络等）：此时 runtime 已 `succeed`、`isCurrent` 为假，既有 `.catch` 会直接忽略。报告已落库，不会被误报成失败。
- 跑满 40 步仍未提交：按「未提交」处理。

### 3.4 记忆工作区：提交后关闭

`createReadingReportMemoryWorkspace` 新增 `close()`。关闭后 `saveMemory` / `updateMemory` 返回 `{ saved/updated: false, hint: "the report has already been submitted; memory changes are closed" }`，不再暂存；`readMemory` 不受影响。

为什么需要：AI SDK 同一步内的多个工具调用用 `Promise.all` 并发执行、按调用顺序起跑。模型若在同一步里先调 `submitReport` 再调 `saveMemory`，后者在事务之后才暂存。不关闭的话，它会返回 `saved: true`，却永远不会落库——静默丢失。关闭后至少如实告知，进度条显示「已跳过」。prompt 也会要求先改记忆、再提交。

不选「提交后改为直接写库」：那要处理已提交 slug 的乐观锁基线更新，复杂度不值得。

### 3.5 prompt

- 新增 `## Delivering the report` 段。不论记忆开关都出现，且不提记忆工具名：
  > Deliver the finished report by calling submitReport with the complete Markdown. Only the submitted Markdown reaches the reader; anything else you write is discarded. If submitReport returns an error, follow it. Once it reports saved, the task is complete.
- `REPORT_MEMORY_GUIDANCE`（仅记忆开启时出现）追加：
  > Make memory changes before calling submitReport: they are saved together with the report, and memory tools close once it is saved.
- `saveMemory` / `updateMemory` 的工具描述：「The memory is saved only if the report succeeds」改为「Saved together with the report when submitReport succeeds」。
- agent 的用户提示末尾加一句 `Deliver it with submitReport.`

### 3.6 `agent.ts`

- `runReadingReportAgent` 改为返回 `Promise<void>`，删掉对 `result.text` 的读取和空文本检查。
- `runAgent` 入参新增 `isSubmitted: () => boolean`，`stopWhen` 改为 `[isStepCount(REPORT_AGENT_MAX_STEPS), () => input.isSubmitted()]`：提交成功的那一步执行完即结束（§5）。
- `maxOutputTokens` 注释里「被空文本检查报成 empty text」改为「表现为报告从未提交」。

### 3.7 进度条

`ReportProgressTimeline.tsx` 的 `TOOL_LABEL_KEYS` 加 `submitReport`，文案「保存报告」/「Saving the report」。成功时 `succeed` 会立刻清掉时间线，所以这一条主要在提交失败（显示「已跳过」）时可见。

### 3.8 可见与可调用范围：仅限阅读报告主 agent

用户要求（2026-10-03）：`submitReport` 严格限定为只有阅读报告 agent 能看到、能调用。

现在会调模型的地方，以及它们各自的工具：

| 调用方                                        | 工具来源                                                       | 能否看到 `submitReport` |
| --------------------------------------------- | -------------------------------------------------------------- | ----------------------- |
| 阅读报告主 agent（`agent.ts`）                | service 每次生成现组装：报告工具 + 记忆工作区 + **submission** | 能，且只有它能          |
| 报告调查子 agent（`investigation-runner.ts`） | `generateText` 不传工具，只回 JSON 文本                        | 不能                    |
| 聊天（阅读器 / 书库，`stream-assistant.ts`）  | `createContextTools` + `createMemoryTools` + 搜索工具          | 不能                    |
| 摘要、记忆整理、会话标题、上下文压缩          | 各自的 `generateText`，不含报告工具                            | 不能                    |

靠以下几点保证，而不是靠约定：

1. **不存在模块级实例**。`submission.ts` 只导出工厂 `createReadingReportSubmission`，不导出现成的 tool，也不加入任何共享的工具表（`createContextTools`、`createMemoryTools`、`createReadingReportTools` 都不含它）。
2. **只有 service 构造它**。工厂必须传入 `commit` 闭包，而唯一的闭包在 `startReadingReportGeneration` 里，绑定到这一次生成的 session id 与 claim generation。只有 `service.ts` 导入这个工厂。
3. **只交给主 agent**。构造出的工具只放进传给 `runAgent` 的那份 ToolSet；`createInvestigator` 收不到它，子 agent 也不带工具。
4. **调用即使越界也写不出去**。就算 ToolSet 被误传到别处，`commit` 也只会写这一次生成对应的那一条阅读记录，且只在该生成仍是当前生成时、只成功一次。
5. **提示词同理**。`submitReport` 的说明只出现在 `buildReadingReportSystemPrompt` 里，聊天和子 agent 的系统提示不提它。

## 4. 测试

**回归（service 层，真 `runReadingReportAgent` + 脚本化 `MockLanguageModelV4`）。** bug 发生在「agent 的输出 → 库里存什么」这条链上，只 mock `runAgent` 的既有 service 测试够不到，所以回归测试放在这一层：

1. **原始场景**：第 1 步 = 正文（纯文字）+ `saveMemory`；第 2 步 = 收尾话；全程没调 `submitReport` → 生成失败，`report` 仍为 null，记忆未写入。（修复前：存进收尾话。）
2. **新契约**：第 1 步 = `saveMemory` + `submitReport(正文)`；第 2 步 = 收尾话 → `report` 为正文，记忆已写入，状态 `ready`。

**单元**

- `submission`：空报告、重复提交、`commit` 抛错（不标记已提交、返回 error）、中止时抛出且不 commit。
- `memory-workspace`：`close()` 后 save/update 被拒，且不进 `mutations()`。
- `prompt`：新段落存在；记忆关闭时仍不出现 `saveMemory`（既有断言）。

**可见范围守卫（§3.8）**：在模型这一侧断言，即 mock 模型实际收到的工具列表，而不是检查我们传了什么参数：

- 报告主 agent：回归 2 里 mock 模型收到的工具列表包含 `submitReport`（正向）。
- 聊天：阅读器（有 bookId）与书库（bookId 为 null）两种上下文下，`MockLanguageModelV4.doStream` 收到的工具列表都不含 `submitReport`；系统提示也不含这个词。
- 调查子 agent：`createInvestigator` 实际调用模型时，`doGenerate` 收到的工具列表为空。

**既有 service 测试**：mock 的 `runAgent` 从「返回字符串」改为「调 `submitReport`」。取消、手动保存、乐观锁冲突几条的语义不变（冲突：`submitReport` 返回 error，agent 不再提交 → 生成失败，旧报告保留，记忆维持外部修改）。

排查时写的临时复现 `agent.test.ts` 测的是被移除的 `result.text` 行为，删除，由回归 1 接替。

## 5. 决策：提交成功即结束循环

用户 2026-10-03 选定：`submitReport` 成功的那一步执行完，agent 循环立刻结束。

- 结果仍如实返回给 agent，同一步内的其他调用照常执行完。
- 省掉的是最后一次模型调用：那一步要把全部上下文（含此前所有工具结果，往往是整轮最大的一次输入）再发一遍，只为一句不展示的收尾话。
- 未选「由 agent 自己收尾」：多一次最大上下文的调用，没有收益（UI 在 3.2 已切到完成）。
