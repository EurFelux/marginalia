# 助手消息显示用量 — Design

**Issue:** #23
**Date:** 2026-10-11
**Source:** 用户请求 2026-10-11（「想要每条助手消息显示 usage」「没有 cache write, cache input 吗？」）；摆法在线框稿的三个方案里选了 C（「我喜欢 C」）；末步上下文、中止补算、悬停打开三项按推荐选定；文案上「其中推理」改为「推理」、「末步上下文」改为「上下文」（用户：「"其中推理" 这个文案很诡异」）。

## 1. 背景

每轮回复结束时，`stream-assistant.ts` 已经把用量写进 `metadata.usage`，但只存了输入、输出两个总数。SDK 交出的缓存命中、缓存写入、未缓存、推理这些拆分都丢掉了，界面上也没有地方显示。中止的回合 SDK 不触发 `onEnd`（中止时直接跳过），所以 `usage` 为空。

## 2. 目标与非目标

**目标**：每条助手消息的操作栏多一个用量图标，鼠标移上去弹出详情卡，显示这一轮的 token 用量，包括缓存命中和缓存写入。

**非目标**：

- 不折算费用（需要维护各模型单价表）。
- 不做会话合计或用量统计页。
- 不显示摘要、会话命名、上下文压缩、记忆整理、阅读报告这些后台调用的用量——它们不是对话里的消息。
- 「上下文」只显示数字，不换算成「占上限百分之几」（没有各模型上下文上限的数据）。

## 3. 设计

### 3.1 入口

- 助手消息操作栏（`MessageToolbar`）在「重新生成」后面加一个图标按钮（lucide `Gauge`），样式与现有按钮相同（`ghost` / `icon-xs` / 弱前景色）。
- 只在这条消息有 `usage` 时出现；没有就不放，也不放占位。
- 流式输出过程中操作栏本来就不显示；这一轮结束、渲染层从 DB 重载消息后，图标随之出现。
- 无障碍标签「本轮用量」。

### 3.2 详情卡

用现有 `HoverCard`（base-ui PreviewCard）：鼠标悬停即弹出，键盘聚焦图标也能打开，不需要点击。卡片默认在图标上方，左对齐。

卡片内容自上而下：

```
claude-sonnet-5-5                3 步
▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▆▆▆▆░░            ← 输入构成比例条
输入                          37,060
  ■ 缓存命中                  28,400
  ■ 缓存写入                   6,200
  ■ 未缓存                     2,460
输出                             912
    推理                         340
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
上下文                        16,900
已中止，未完成的一步不计                ← 仅中止 / 出错时
```

逐项规则：

| 项                           | 来源                           | 何时显示                                     |
| ---------------------------- | ------------------------------ | -------------------------------------------- |
| 模型名                       | `metadata.model`               | 有就显示                                     |
| N 步                         | `usage.stepCount`              | 有就显示（旧消息没有）                       |
| 比例条                       | 命中 / 写入 / 未缓存           | 三项中至少有一项时                           |
| 输入、输出                   | `inputTokens` / `outputTokens` | 恒显示                                       |
| 缓存命中 / 缓存写入 / 未缓存 | 对应字段                       | 字段存在就显示，值为 0 也显示                |
| 推理                         | `reasoningTokens`              | 大于 0 时                                    |
| 上下文                       | `lastStepInputTokens`          | `stepCount > 1` 时（单步时它等于输入，省掉） |
| 中止 / 出错脚注              | 消息 `status`                  | `aborted` / `error` 时                       |

- 数字写完整值加千分位（`Intl.NumberFormat`，跟随界面语言），不缩写。
- 比例条与色点只用前景色的不同深浅（与 app 的单色调一致），不引入新色。
- 「输入」是每一步相加的量，即实际计费口径；「上下文」是最后一次请求的输入，表示当前上下文有多大。两者在多步回合里可能差一倍以上，卡片上不再另加解释文字。

### 3.3 各 provider 报什么

以本仓库所用 SDK 版本的 usage 映射为准（`node_modules/@ai-sdk/*`）：

| provider                   | 缓存命中 | 缓存写入                           | 推理                                      |
| -------------------------- | -------- | ---------------------------------- | ----------------------------------------- |
| Anthropic                  | ✓        | ✓（没写入时为 0）                  | 仅开 thinking 且返回 `thinking_tokens` 时 |
| OpenAI（responses / chat） | ✓        | 仅响应里带 `cache_write_tokens` 时 | ✓（无则 0）                               |
| DeepSeek                   | ✓        | 无                                 | ✓（无则 0）                               |
| Google                     | ✓        | 无                                 | ✓（无则 0）                               |

按 §3.2 的规则，没有报的项（`undefined`）不出现在卡片上；所以 Anthropic 会有「缓存写入」行，其余几家通常没有。

### 3.4 中止与出错

按已完成的步骤补算：把已完成各步的用量加起来存下，正在进行的那一步拿不到用量，不计。所以数字会偏少，卡片底部用脚注说明：

- `aborted`：「已中止，未完成的一步不计」
- `error`：「出错，未完成的一步不计」

一步都没完成时不存 `usage`，图标不出现。

## 4. 数据

### 4.1 存储

`messageMetadataSchema.usage`（`src/shared/types.ts`）在既有两个必填字段之外加可选字段，平铺：

```ts
usage: {
  inputTokens: number;          // 既有：各步输入之和
  outputTokens: number;         // 既有：各步输出之和
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  noCacheTokens?: number;
  reasoningTokens?: number;
  stepCount?: number;           // 已完成的步数
  lastStepInputTokens?: number; // 最后一个已完成步骤的输入
}
```

全部为非负整数。`metadata` 是 JSON 列，旧数据（只有两个总数）照样能通过校验，不需要迁移。

### 4.2 采集

- `streamAssistantReply` 不再用 `onEnd` 取累计值，改为在 `onStepEnd` 里收集每一步的 `usage`。完成、中止、出错三种结局走同一条路径；完成时各步之和与 `onEnd` 给的累计值相同。
- 汇总逻辑抽成纯函数（新文件 `src/main/ai/usage.ts`）：输入各步 `LanguageModelUsage`，输出 §4.1 的形状。
  - 没有步骤，或输入、输出总数拿不到，返回 `undefined`。
  - 各拆分项的相加规则与 SDK 的 `addTokenCounts` 一致：各步都是 `undefined` 时结果为 `undefined`，否则把 `undefined` 当 0 相加。结果为 `undefined` 的字段不写入。
- 落库时机不变：仍在 `toUIMessageStream` 的 `onFinish` 里随助手消息一起写（`onStepEnd` 先于它触发，与现有 `lastFinish` 的时序相同）。

### 4.3 渲染层

- `messageDtoToUIMessage` 把 `metadata.usage`、`metadata.model` 和 `status` 一并带进 `ChatMetadata`（目前只带了 `createdAt` 与 `contextChips`）。
- 详情卡显示哪些行由一个纯函数决定（输入 usage、model、status，输出要显示的行），与组件分开，便于测试。

## 5. 影响范围

- `src/shared/types.ts`：扩 `usage` schema。
- `src/main/ai/usage.ts`（新）：汇总纯函数。
- `src/main/ai/stream-assistant.ts`：`onEnd` 改为 `onStepEnd` 收集；落库用汇总结果。
- `src/renderer/ai/types.ts`、`message-history.ts`：`ChatMetadata` 加字段并水合。
- `src/renderer/ai/MessageToolbar.tsx`：加图标与详情卡；卡片组件放新文件 `MessageUsageCard.tsx`。
- 文案（zh-CN / en）：本轮用量、输入、输出、缓存命中、缓存写入、未缓存、推理（英文 Reasoning）、上下文（英文 Context）、N 步、两条脚注。

## 6. 测试

- `usage.test.ts`：多步相加；provider 不报缓存写入时字段缺省；全部拿不到时返回 `undefined`；`stepCount` 与 `lastStepInputTokens` 取值。
- 发送链路（`send.test.ts` 一类）：完成的回合存下拆分；多步中途中止时存下已完成步骤之和；一步未完成就中止时不存 `usage`。
- 渲染层：`messageDtoToUIMessage` 带上 usage / model / status；行规则纯函数覆盖 §3.2 表中每一行的显示条件。
- 手测：分别用 Anthropic 与 DeepSeek 实跑，确认卡片上缓存行与 §3.3 一致；中止一轮多步回答，确认脚注与数字。
