# 聊天回合终态建模 · 设计文档

> 日期：2026-09-24
> 关联：issue #109；`2026-06-03-db-lifecycle-rules-design.md` §3（AI 终态模型，本文修正其 `streamHadError` 的信号源）；#24（流级 provider 错误的结构化分类，不在本文范围）。

## 背景与目标

一轮聊天的终态（`messages.status` + 用户可见反馈）目前靠零散信号判定，有三处与实际不符（均经 `runSend` 探针测试实测）：

1. **异常 finish reason 无反馈**。除 debug 日志外没有代码读 `finishReason`。以 `length` / `content-filter` / `error`（无 error part）结束的回合落 `complete`、无横幅。`@ai-sdk/provider` 契约中 `finish.finishReason` 与 `error` part 相互独立；`ai@7.0.112` 不会因任何 finish reason 取值产出 error chunk。
2. **悬空工具步骤**。合法的完整工具调用若所在 step 以不安全的 finish reason 结束，`ai`（7.0.70 起的 `isToolExecutionAllowedFinishReason`）跳过执行、多步循环终止；工具 part 停在 `input-available`，渲染层永久显示「读取中…」。
3. **自愈回合被记为 error**。`stream-assistant.ts` 在 `toUIMessageStream` 的 `onError` 每次被调用时置 `streamHadError`。但该回调同时负责格式化 `tool-input-error`（非法 JSON / 参数不合 schema / 未知工具）与 `tool-output-error`（execute 抛错）的 errorText；这些情况下 SDK 把错误作为工具结果喂回模型、循环正常跑完，回合却落 `status=error`，连带跳过命名、压缩、记忆整理。

**目标**：回合终态如实反映「这一轮是否因流级错误终止」，且每个需要用户知道的结局都有可见反馈。

**原则**：**只有流级错误才落 `error`；模型能在循环内自愈的不算流级错误。**

## 判定表

| 回合结局                                                    | `status`                           | `metadata`                         | 用户反馈                       |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------------------- | ------------------------------ |
| `stop` / `tool-calls` / `other`                             | `complete`                         | —                                  | 无                             |
| 工具层错误（非法 JSON、参数不合法、未知工具、execute 抛错） | `complete`                         | —                                  | 工具步骤显示「失败」，循环继续 |
| `length` / `content-filter`                                 | `complete`（截断正文视为完整正文） | `finish: { reason, raw }`          | 错误横幅                       |
| `finishReason: "error"` 且无 error part                     | `error`，已得正文保留              | `finish: { reason, raw }`          | 错误横幅                       |
| 流级错误（error chunk / 调用抛错）                          | `error`，已得正文保留              | `error: { name, message }`（现状） | 错误横幅（现状）               |
| 用户中止                                                    | `aborted`（现状）                  | —                                  | 无（现状）                     |

`other` 不反馈：前提是 provider 返回规范响应，`other` 视为不规范的 finish reason 静默接受。

## 设计

### 主进程

**`finishFeedback()`（新，`src/main/ai/finish-feedback.ts`，纯函数）**

```ts
type FinishFeedbackCode = "truncated" | "content-filtered" | "provider-error";
function finishFeedback(input: {
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}): { code: FinishFeedbackCode; message: string } | null;
```

`length → truncated`、`content-filter → content-filtered`、`error → provider-error`，其余 `null`。`message` 在主进程用 `t()` 本地化（与 `errors.*` 惯例一致），`provider-error` 在有 raw 值时附上原文。落库与反馈共用这一个判定，保证两侧结论一致。

**`stream-assistant.ts` 改动**

- `streamHadError` / `errorInfo` 改由 **`streamText` 的 `onError`** 设置——它只在流中出现 `error` chunk 时触发（`ai` 的 eventProcessor 按 `chunk.type === "error"` 分发），工具层错误走 `tool-error` part，不触发。
- `toUIMessageStream` 的 `onError` 退化为纯 errorText 格式化器，并留 `log.warn`（被吞的软失败必须留痕）。
- `streamText` 的 `onEnd` 额外记下 `finishReason` / `rawFinishReason`。
- 落库（`toUIMessageStream` `onFinish`）：`feedback = streamHadError ? null : finishFeedback(...)`。`feedback?.code === "provider-error"` 时 `status = "error"`；有 feedback 时写 `metadata.finish`。`aborted` 优先级不变。
- 反馈：tee 之后给渲染层的那一路（`callerStream`）经一个 TransformStream，遇到 UI `finish` chunk 时若 feedback 非空，先插入 `{ type: "error", errorText: feedback.message }`。**每轮至多一条反馈**：已出现过 `error` chunk 的回合不再插入（上面 `streamHadError ? null` 已保证；以后 SDK 若开始为某些 finish reason 发 error chunk，也不会重复）。落库那一路不经此变换。

`finishFeedback` 的结果需要在 `onFinish`（落库）与 callerStream 变换（反馈）两处使用，二者都在 `onEnd` 之后，按一次计算、共享结果实现。

**`metadata.finish`（`src/shared/types.ts`）**

`messageMetadataSchema` 增加可选 `finish: { reason: string; raw?: string }`。JSON 列、可选字段，无需迁移。仅在有反馈时写入。

**`tools.ts` 的 `runTool` 注释**

原注释称「execute 抛错会中断整条流式回复（onError → 该轮 status=error）」——是本文第 3 点的误判造成的表象。`runTool` 转 `{ error }` 的做法保留，注释改为说明其实际价值：把错误原文作为正常 result 交给模型。

### 渲染层

- **横幅**：`AIPanel` 的错误横幅保留，前缀由「发送失败」改为中性的「回复出错」；删除写死的「请确认已在设置配置 API Key 与模型」提示——反馈文案自带建议，流级错误显示 provider 原文。
- **悬空工具步骤**：`toolStepStatus` 增加「未执行」态。消息不在流式中（`AssistantBubble` 的 `streaming` 为 false）且工具 part 无 output 时显示「未执行」，不再 `animate-pulse`。

### 不变的部分

- 流到一半出错时已拿到的正文落库、`AIPanel` 在 error 态从 DB 重载显示——现状已满足。
- 下一轮上下文：`prompt.ts` 的 `ignoreIncompleteToolCalls: true` 已丢弃悬空工具调用。

## 范围

**不在范围内**：

- 步数用尽（`tool-calls` 结束但被 `stopWhen` 截停、无最终答案）的反馈。
- 重载历史后显示出错 / 截断标记（渲染层当前丢弃 `status` 与 `metadata`）。
- 阅读报告（#106）、摘要、标题、压缩、记忆整理接入 `finishFeedback`。
- 流级 provider 错误的结构化分类（#24）。

## 测试

`send.test.ts`，`MockLanguageModelV4` 驱动真实 `runSend`：

- 判定表每一行断言 `status`、`metadata.finish` / `metadata.error`，以及 callerStream 中 `error` chunk 的有无与位置（在 `finish` 之前）。
- 非法 JSON / 参数不合 schema 的工具调用，模型第二步自愈 → `complete`、无 error chunk、工具 part `output-error`。
- 流级 error part 后 finishReason 被 SDK 改写为 `error` → 仅一条 error chunk。
- `finishFeedback` 纯函数单测；`toolStepStatus` 的「未执行」态单测。
