# 阅读报告生成进度反馈

日期：2026-08-10

## 问题

生成阅读报告要跑一个最多 40 步的 agent，还会派 subagent 深读长会话，整体可能耗时数分钟。当前渲染层在这段时间里只显示一句静态的「生成中…」（`ReadingReportView.tsx` 的 `model.busy` 分支），既没有活性指示，也没有任何关于「在干嘛 / 还剩多少」的信息。用户无法区分「正在推进」和「已经卡死」，只能硬等。

## 范围

本次实现 **活性指示（耗时计时）+ 活动时间线**。

**正文流式渲染是既定的下一步**，本设计中不实现，但所有接口按「将来 `generateText` → `streamText` 时时间线一行不用改」来划分。

明确不做（YAGNI）：

- subagent 内部工具调用冒泡为子条目；
- 时间线持久化到 SQLite（重启即弃，与 `ReadingReportRuntime` 现有的纯内存设计一致）；
- 书库页等其他视图的全局「有报告在生成」指示。

## 设计决策

### 采集：包一层 ToolSet 装饰器

新增 `src/main/reading-report/progress.ts`，导出 `withProgress(tools, sink)`：遍历 ToolSet，把每个工具的 `execute` 包成「入口 `sink.start(...)`，出口 `sink.finish(...)`」。`service.ts` 单点接入：

```ts
const tools = withProgress({ ...toolset, ...memoryWorkspace.tools }, deps.runtime.sink(sessionId));
```

不用 `generateText` 的 `onStepFinish`：它只在步**结束后**触发，「正在读第 3 个会话」要等读完才显示，恰好错过需要反馈的那段时间。装饰器在 `execute` 入口即可上报「开始了」。

装饰器还带来两个白送的性质：并发工具调用天然产生多条「进行中」条目（第五问的并发可见）；不侵入 `tools.ts` / `createReadingTools`，聊天侧工具完全不受影响。

**工具抛错时也必须 `finish`**，否则条目永远转圈。

### 上报数据而非文案

主进程只发结构化事件，本地化留给渲染层——否则主进程要持有 i18n 实例，破坏纯函数可测性。

```ts
{ id, tool: "readConversation", startedAt, endedAt: number | null,
  outcome: "ok" | "error" | null, count?: number }
```

`count` 由一张**纯函数映射表**从工具输出里抽（分页工具取 `items.length`，等等），抽不到就不带。该表独立可测。

### 状态存在 runtime 里

`ReadingReportRuntime` 加 `#progress: Map<sessionId, Step[]>`，环形缓冲**上限 50 条**（40 步上限 + 余量，防异常循环撑爆内存）。

生命周期——**成功即弃，失败保留**：

| 时机           | 处理                                   |
| -------------- | -------------------------------------- |
| `claim()`      | 清空                                   |
| `succeed()`    | 清空（报告已出，过程即噪音）           |
| `fail()`       | **保留**（唯一的诊断线索：卡在哪一步） |
| `cancel()`     | 清空                                   |
| `invalidate()` | 清空（用户手动保存覆盖了整次生成）     |

`cancel()` 也清空：取消后状态回到 `empty` / `ready`，这两个变体不承载 `progress`，时间线无处可显；且用户是主动叫停的，不需要诊断线索。**唯一保留时间线的场合是失败。**

### 传输：复用现成轮询，不新增 IPC 通道

`readingSessionQuery` 在生成期间已经以 400ms 轮询 `readingSessions.get`，扩 DTO 即可。

`src/shared/reading-sessions.ts` 的 `readingReportStateSchema` 中，`generating` / `regenerating` / `generation-failed` / `regeneration-failed` 四个变体各加：

- `progress: Step[]`
- `startedAt: number`

**所有计时在客户端算**（总耗时、单步秒数），主进程不推秒数，因此 400ms 轮询的间隙里画面也不会僵住。

### 渲染层：`ReportProgressTimeline`

新组件 `src/renderer/reading/ReportProgressTimeline.tsx`，填进报告卡片里现在显示静态「生成中…」的那块空白。

```
正在生成报告 · 已用 2:14 · 已完成 12 步
─────────────────────────────────
✓ 清点本次标注          24 条
✓ 列出本次会话           3 个
✓ 读会话内容            20 条
⟳ 派调查员深读长会话      47s     ← 进行中，秒数客户端自增
⟳ 派调查员深读长会话      12s     ← 并发第二条
```

- `max-h` + `overflow-y-auto`，新条目进来自动滚到底；
- 文案走 i18n key `readingReport.progress.<toolName>`，`count` 作插值；
- **未知工具名回退到一句通用文案**——将来新增工具忘了配文案，退化成一条素条目，而不是崩掉或显示原始英文工具名；
- 工具软失败（`investigateConversation` 返回 `failed`、`runTool` 吞错）显示为灰色「已跳过」，不标红：那是既定的降级路径，标红会误导用户以为整份报告废了；
- 视图状态判断收进已有的 `report-view-model.ts`（`busy` / `canCancel` 等已在那里），组件保持纯展示。

### 为流式正文留的口子

时间线是独立组件，数据来自 DTO 而非流式回调；`withProgress` 装饰工具本身，与调用方式无关。下一阶段只需把时间线改成正文上方的收起态、正文接流，两处互不影响。

## 被否决的备选

| 备选                             | 否决理由                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 只做转圈 + 耗时（不做时间线）    | 解决「是否还活着」，但解决不了「还要多久」；转圈转五分钟一样让人抓狂。                                                           |
| 先做正文流式                     | 真正耗时的是前面几十步工具调用，正文那步很快；流式只在最后几秒热闹，前面照样干等。                                               |
| 单行「当前正在做什么」           | 丢掉了「一直在推进」这个最能缓解焦虑的信号；某步卡 90 秒时，看起来和死掉一模一样。                                               |
| 阶段聚合（收集 → 深读 → 撰写）   | 阶段划分是硬编码假设，而 agent 执行顺序自由（可能读完正文又回头翻会话），硬套会显示错。                                          |
| 让模型自己播报（`narrate` 工具） | 多耗一次工具调用（40 步本就紧张），且模型常忘记播报，反而制造空窗。                                                              |
| 成功后保留时间线可展开回看       | 用户真正想要的是**溯源**（正文哪句话有什么依据），时间线给不了这个映射，只会假装能给。溯源应在正文里挂引用，属另一条线。         |
| subagent 内部事件冒泡            | 要串一条新回调链穿过 `investigation-runner` → `investigator`，收益是「更细的细节」而非「有没有反馈」；单步计时已能证明时钟在走。 |

## 验证

`pnpm test` + `pnpm typecheck` + `pnpm lint`，并跑 `pnpm i18n:extract` / `pnpm i18n:lint` 同步校验新 key。

测试覆盖：

- `progress.test.ts`：装饰器透传返回值、工具抛错时也 `finish`、并发调用产生并列条目、count 映射表逐工具；
- runtime 现有测试扩展：`claim` 清空、`succeed` 清空、`fail` / `cancel` 保留、环形缓冲截断到 50；
- `report-view-model.test.ts` 扩展：四个新状态各自的时间线可见性。
