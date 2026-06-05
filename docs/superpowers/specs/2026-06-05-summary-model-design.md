# 独立摘要模型设计

日期：2026-06-05
状态：已与用户对齐，待实现
关联：ROADMAP backlog「独立『摘要模型』设置」（core §11）

## 1. 背景与动机

章节摘要、全书摘要、会话自动起名（auto naming）三个后台轻量任务目前与聊天共用同一个模型（默认 Assistant 的 `providerId + model`，经 `resolveAssistantModel(db)` 解析）。摘要/起名是高频、低难度任务，强聊天模型既贵又慢；用户希望为它们单独配置一个（通常更便宜更快的）模型。

## 2. 决策摘要

| 决策点        | 结论                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| 作用域        | 一个槽位管全部轻量任务：**章节摘要 + 全书摘要 + auto naming**；聊天本体不动                         |
| 存储          | `preferences` 表注册新 key `summaryModel`（k-v + Zod 注册表，**无 DB 迁移**）；不动 `assistants` 表 |
| 未配置语义    | **报错，不回退聊天模型**（用户显式决策：显式优于隐式回退）                                          |
| provider 被删 | 残留配置同样**报错**（「未找到所配置的 Provider」），重新配置即修复；无级联清理代码                 |
| UI 命名       | 设置页区块叫「摘要模型」，描述注明「用于章节/全书摘要与会话自动命名」                               |
| 测试连接      | 摘要模型区块也有「测试连接」；`testResult` 由 settings-store 单槽**退役为组件本地状态**             |
| 升级体验      | 有意 breaking：升级后未配置 → 摘要/起名进入「未配置」态，需去设置页配置一次                         |

## 3. 存储：preferences 注册 `summaryModel`

`src/shared/preferences.ts`：

```ts
export const summaryModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
```

- 注册进 `PREFERENCE_SCHEMAS`（key：`summaryModel`）+ `setPreferenceInput` 判别联合补一条 arm（`preferences.test.ts` 强制两处同步）。
- 值语义：**未存 = 未配置（报错态）**；存了 = 指定 (provider, model) 对。没有「跟随对话模型」的特殊值。

## 4. 解析：`resolveSummaryModel(db)`

放 `src/main/ai/assistant-model.ts`，与 `resolveAssistantModel` 并列（同构兄弟，共享 `ResolvedModel` 判别联合与错误构造风格）：

1. `getPreference(db, "summaryModel")` 为 null → `{ ok: false, reason: t("errors.summaryModelNotConfigured", "未配置摘要模型") }`（新 i18n key）
2. `loadProvider` 找不到 providerId（provider 已删、配置残留）→ 复用 `errors.assistantProviderNotFound`（「未找到所配置的$t(terms.provider)」，文案无 assistant 字样可通用）
3. provider 无 apiKey → 复用 `errors.assistantNoApiKey`（「$t(terms.provider)未设置密钥」）
4. 成功 → `resolveLanguageModel({ type, baseUrl, apiKey, model })` 构建，返回 `{ ok: true, model, modelId }`

## 5. 链路注入

| 链路          | 注入点                           | 改动                                                                                                                                             |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 章节+全书摘要 | `send-deps.ts` `makeSummaryDeps` | `resolveModel: () => resolveSummaryModel(db)`                                                                                                    |
| auto naming   | `SendDeps`（`send.ts`）          | 新增字段 `resolveSummaryModel: () => ResolvedModel`；`onFinish` 里传给 `nameConversation` 替代现在的 `resolveModel`；`makeSendDeps` 注入生产实现 |
| 聊天本体      | —                                | 零改动（仍走 `resolveModel` = `resolveAssistantModel`）                                                                                          |

`conversation-title.ts` 的 deps 形状不变（已是注入式 `resolveModel`），只换 send.ts 传入的实现。

### 错误表现（全部沿用现有语义，零新机制）

- 手动生成摘要（pill 点击）→ `assertSummaryModelReady` 抛「未配置摘要模型」→ generate handler reject → 渲染层 toast 透传真实原因。
- 开章自动触发 → `ensure*` 的 `!resolved.ok → return` 静默保持 pending。
- auto naming → `nameConversation` 内 `!resolved.ok → return`，标题保持 i18n 占位（「未命名会话」）。

## 6. 设置 UI：「摘要模型」区块

- `ModelsSettings` 在 `AssistantModelPicker`（对话模型）之下新增 `SummaryModelPicker`（摘要模型）。
- 形态与对话模型区块一致：provider/model 双 Select 网格 + 「测试连接」按钮（复用 `settings.providers.test` IPC）。两个 picker 提取共享展示基件（provider/model 双 Select 网格，受控 value/onChange；具体拆分 plan 阶段定），数据接线各自持有：
  - 对话模型：assistant query + `settings.assistant.update` mutation（现状不变）。
  - 摘要模型：偏好值与 `autoSummarize` 同构——prefs store 新槽 `summaryModel`（`hydrate-preferences.ts` 补一行快照灌入；action 内 `persistPreference` 写回）。**不可**用 react-query 直读 `preferences.getAll()`：preload 的快照是启动时 sendSync 缓存的，set 后不刷新，会读到陈旧值。providers 列表复用 react-query `qk.providers`。
- 防呆逻辑照搬：切 provider 时清 model（避免非法 (provider, model) 残留对），变更后清测试结果。
- 未配置 → 双 Select 显示 placeholder；providerId 残留但 provider 已删 → 同样落到 placeholder（select 值不在选项中）。
- 区块描述文案：「用于章节/全书摘要与会话自动命名」。
- **`testResult` 退役 store 单槽**：现 settings-store 的 `testResult`/`setTestResult` 唯一消费者是 `AssistantModelPicker`，且 `ProviderCard` 已有「测试结果是组件自有状态」先例——两个 picker 均改为组件本地状态，settings-store 相应字段删除。

## 7. 影响面清单

| 层       | 文件                                    | 变更                                                                    |
| -------- | --------------------------------------- | ----------------------------------------------------------------------- |
| shared   | `preferences.ts`                        | `summaryModelSchema` + 注册 key + setPreferenceInput arm                |
| 主进程   | `ai/assistant-model.ts`                 | 新增 `resolveSummaryModel(db)`                                          |
| 主进程   | `ai/send-deps.ts`                       | `makeSummaryDeps` 改接；`makeSendDeps` 注入新字段                       |
| 主进程   | `ai/send.ts`                            | `SendDeps` 新增 `resolveSummaryModel`；onFinish 传给 `nameConversation` |
| 主进程   | i18n locales                            | 新 key `errors.summaryModelNotConfigured`                               |
| renderer | `settings/SummaryModelPicker.tsx`（新） | 摘要模型区块                                                            |
| renderer | `settings/AssistantModelPicker.tsx`     | 提取共享基件；testResult 改本地状态                                     |
| renderer | `settings/ModelsSettings.tsx`           | 挂 SummaryModelPicker                                                   |
| renderer | `store/prefs-store.ts`                  | 新槽 `summaryModel` + 设值 action（内含 persistPreference）             |
| renderer | `store/hydrate-preferences.ts`          | 快照灌入补一行                                                          |
| renderer | `store/settings-store.ts`               | 删 `testResult`/`setTestResult`                                         |
| renderer | i18n locales                            | 「摘要模型」区块文案（extract 收口）                                    |

## 8. 测试与验证

- `resolveSummaryModel` 四分支单测（未配置 / provider 已删 / 无密钥 / 成功）。
- `send-deps`：`makeSummaryDeps`/`makeSendDeps` 接线断言。
- `send.test`：onFinish 起名走 `resolveSummaryModel` 而非 `resolveModel`（注入两个不同 fake 验证调用对象）。
- `preferences.test.ts` 既有同步校验自动覆盖新 key 注册完整性。
- UI 手测 + CDP 真启动冒烟：设置页配置摘要模型 → 生成章节摘要走新模型；未配置 → pill 手动生成 toast「未配置摘要模型」；起名跳过保持占位标题。

## 9. 非目标

- 不做「跟随对话模型」选项或隐式回退。
- 不做按任务（章节摘要 vs 全书摘要 vs 起名）分别配置。
- 不动摘要生成参数（截断上限 / maxOutputTokens / 流式机制）。
- 不做升级引导/onboarding 提示（backlog 已有 onboarding 事项，届时一起）。
