# 对话/摘要模型的推理强度配置 — 设计（v7）

- 日期：2026-07-13
- 状态：已通过评审，待写实现计划
- 前置：已完成 AI SDK v6→v7 迁移（main：`afc5b70`/`8dc5f4e`）。本设计基于 v7。
- 相关代码：`src/shared/preferences.ts`、`src/main/ai/{assistant-model,stream-assistant,summary,conversation-title,context-compaction,memory-consolidation}.ts`、`src/renderer/settings/{AssistantModelPicker,SummaryModelPicker}.tsx`

## 1. 背景与目标

目前对话（chat/send）与摘要（chapter/book summary）调用 AI 时**完全没有**下发推理强度配置。用户希望能为**对话模型**和**摘要模型**分别配置推理强度，对用户暴露 `关闭(none) / 低 / 中 / 高` 四档（外加「默认/未设置」）。

**关键：AI SDK v7 已内置这层抽象。** `streamText`/`generateText` 有一个顶层 `reasoning` 参数，取值 `'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`，由 SDK 负责翻译成各 provider 的原生推理配置。我们要的 `low/medium/high` 是它的直接子集。因此**不需要**手写 per-provider 映射层——这正是当初考虑在 v6 上做、后来决定先迁 v7 的原因。

### 非目标（YAGNI）

- **不做 per-model 能力检测**。无条件把所选档位作为顶层 `reasoning` 下发。若具体模型不支持（如 Claude Haiku 4.5 会报错），收到 provider 的真实报错；解法是把档位设回「默认」。「未设置」态即逃生口。
- 不引入 `temperature`/`maxOutputTokens` 等其它采样参数。
- 暴露 none/low/medium/high（不暴露 minimal/xhigh 为独立档；「默认」= 不下发 = provider-default）。`none` = 关闭推理（provider 支持才生效，见 §7）。

## 2. 关键决策（评审已定，v6/v7 通用）

| 决策             | 结论                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 强度设置存哪里   | **挂在现有模型偏好上**：`chatModel` / `summaryModel` 各加一个可选 `reasoningEffort` 字段。强度跟模型选择一起存、一起改。 |
| 默认/未设置档    | **需要**。未设置 = 不下发 `reasoning`（= provider-default，保持现状）。UI 是「默认 + 低 + 中 + 高」四态。                |
| 后台任务是否套用 | **是**。摘要模型还用于会话自动命名、上下文压缩、记忆整理——凡用到该模型处都套用摘要模型的推理强度。                       |

## 3. v7 顶层 `reasoning` 的行为（已对实际安装的 `ai@7.0.22` 取证）

- `streamText`/`generateText` 接受顶层 `reasoning?: 'provider-default'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh'`（`ai/dist` 与 `@ai-sdk/provider` 的 `LanguageModelV4CallOptions.reasoning`）。省略 = `'provider-default'`。
- 四类 provider 的翻译（对实际安装的 v4/v3 dist 取证）：
  - **anthropic** → `effort`（枚举吻合）
  - **openai-responses / openai-chat-completions**（`@ai-sdk/openai` v4）→ `reasoning_effort`
  - **openai-compatible**（`@ai-sdk/openai-compatible` v3，DeepSeek 等）→ body `reasoning_effort`。已核实：其 `getArgs` 把顶层 `reasoning`（经 `isCustomReasoning`，即除 `provider-default`/`undefined` 外全部）映射到 `reasoning_effort`；`low/medium/high` 均透传，无需 `providerOptions` 兜底。
  - **google-generate-content** → `thinkingConfig`（`thinkingLevel`/`thinkingBudget`）
- **不可与 `providerOptions` 里的推理字段并存**：v7 中若同时设了 `providerOptions.<provider>` 的推理字段，会静默夺权、顶层 `reasoning` 被忽略。本项目现状没设任何推理 `providerOptions`（仅 openai-responses 的 `store:false` 与 anthropic 的 `cacheControl`，均非推理），故干净、无冲突。

## 4. 设计

### 4.1 共享层（`src/shared/preferences.ts`）

新增枚举：

```ts
/** 推理强度三档（映射到 v7 顶层 reasoning 的同名值）。未设置 = 不下发、用 provider 默认。 */
export const reasoningEffort = z.enum(["none", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffort>;
```

扩展两个模型 schema（追加可选字段，向后兼容旧落盘 JSON）：

```ts
export const summaryModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffort.optional(), // 缺省 = 未设置
});

export const chatModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffort.optional(),
});
```

**无需改动** `PREFERENCE_SCHEMAS`、`setPreferenceInput`（discriminatedUnion arm 引用的正是这两个 schema）、`preferences-handlers.ts` switch、`prefs-store.ts`、`hydrate-preferences.ts`——没有新增 preference key，只是既有 key 的值形状扩展。旧的 `{ providerId, model }` 落盘值 parse 通过，`reasoningEffort` 为 `undefined`。

### 4.2 解析层透传（`src/main/ai/assistant-model.ts`）

`ResolvedModel` 的 ok 分支加 `reasoningEffort?: ReasoningEffort`；`resolveChatModel` / `resolveSummaryModel` 成功返回时带上 `reasoningEffort: pref.reasoningEffort`：

```ts
export type ResolvedModel =
  | {
      ok: true;
      model: ChatModel;
      modelId: string;
      providerType?: AiProviderApiType;
      reasoningEffort?: ReasoningEffort;
    }
  | { ok: false; reason: string };

// 成功分支追加 reasoningEffort: pref.reasoningEffort
```

### 4.3 调用点接线（六处，直接传顶层 `reasoning`）

每处 `streamText`/`generateText` 加一行 `reasoning: resolved.reasoningEffort`。因 `reasoning?` 取值含 `undefined`（等价省略 = provider-default），`resolved.reasoningEffort`（`ReasoningEffort | undefined`）可**直接**传、无需分支：

| 文件                      | 调用                                                |
| ------------------------- | --------------------------------------------------- |
| `stream-assistant.ts`     | 对话 `streamText`（`ctx.resolved.reasoningEffort`） |
| `summary.ts`（章节）      | `generateText`                                      |
| `summary.ts`（全书）      | `streamText`                                        |
| `conversation-title.ts`   | `generateText`                                      |
| `context-compaction.ts`   | `generateText`                                      |
| `memory-consolidation.ts` | `generateText`                                      |

后五处 `resolved` 均来自 `resolveSummaryModel`，故自动套用摘要模型的推理强度（决策 §2）。

> 无新增模块、无 `providerOptions` 改动、无合并逻辑——顶层 `reasoning` 与既有 `providerCallOptions`（`store:false`）、prompt-caching 互不影响。

### 4.4 UI（`AssistantModelPicker.tsx` / `SummaryModelPicker.tsx`）

每个 picker 增加一个小的档位选择器（分段或下拉），五个选项：**默认 / 关闭 / 低 / 中 / 高**。

- 「默认」= `reasoningEffort` 字段不写入（undefined，`JSON.stringify` 天然丢弃）。
- 改档位 → 以当前 `chatModel`/`summaryModel` 为基础，仅替换 `reasoningEffort`，保留 providerId+model，走既有 `setChatModel`/`setSummaryModel`。
- 改模型 → 保留当前档位。
- 未选模型时档位选择器禁用。
- 文案走 i18n `t()`；改完跑 `pnpm i18n:extract`。

## 5. 测试

- **shared schema**：`reasoningEffort` 枚举 + 两个模型 schema 的可选字段解析（含旧值向后兼容：`{providerId, model}` parse 后 `reasoningEffort` 为 undefined）。
- **解析透传**：扩展 `assistant-model` 测试，断言 `reasoningEffort` 从偏好读出、出现在 `ResolvedModel`。
- **调用点传参**：`send.test.ts` 已有 capturing-model 模式（捕获 streamText 调用参数）——断言 `reasoning` 被透传（设了档位时为该值，未设置时为 undefined）。摘要侧同理用捕获 mock 断言。
- 全量 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`。
- **真实冒烟**（需 API Key + GUI）：设不同档位发消息，确认 provider 实际收到对应推理配置（可借 provider 日志或响应差异观察）。

## 6. 兼容性与迁移

- 无 DB schema 变更、无 drizzle 迁移：`reasoningEffort` 是 `preferences.value` JSON 内的可选字段。
- 旧落盘 `chatModel`/`summaryModel` 值（无该字段）parse 通过 = 未设置 = 现状行为，零迁移。

## 7. 风险

- **模型不支持推理强度**：见 §1 非目标。已知 Claude Haiku 4.5 的推理档会报错。缓解 = 「默认」档；文档说明。误设导致的 provider 报错以真实错误流回（对话侧走既有 error 收尾，摘要侧标 failed 可重试）。
- **`none`（关闭）是 best-effort**（官方 JSDoc："disable reasoning **if supported by the provider**"）：支持切换 thinking 的模型（如 Opus 4.8、Gemini flash `thinkingBudget=0`）能真关；always-on 推理模型（如 Fable 5 系）会报错；**openai-compatible（DeepSeek）** 源码里 `none` 被 `reasoning !== "none"` 守卫排除 → 退化为「不下发」≈ provider 默认，并非真关。与其它档位同一「不支持则设回默认」策略。
- **v7 顶层 `reasoning` 与 `providerOptions` 不可并存**：本项目无推理类 `providerOptions`，无冲突（§3）；后续若有人给某 provider 加推理类 `providerOptions`，需注意会静默夺权。
