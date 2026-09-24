# Onboarding / Landing Flow — Design

**Issue:** #25 Onboarding / landing flow (configure provider + enable auto-summary)
**Date:** 2026-06-09
**Source:** ROADMAP backlog + memory `onboarding-guide-auto-summary`；brainstorming 会话 2026-06-09

## 1. 目标与非目标

**目标**：首次启动温和引导用户开启 AI 阅读能力——① 连接 AI 模型（填密钥 + 选对话模型），② 开启「开章自动生成摘要」（默认关）。让新用户不必摸索就知道这两个能力存在并能一键到位。

**非目标**：

- 不阻断阅读。导入、阅读、TOC、进度、标注**完全不依赖 AI**，引导绝不挡路、随时可跳过。
- 不做多步全屏向导（姿态已定为「温和可跳过」，见 §2）。
- 不在卡片内重建 provider 配置 UI（provider 类型 / baseUrl / 测试连接 / 多 provider 等复杂度仍归设置页）。
- 不改 `resolveSummaryModel`「绝不回退聊天模型」的既有契约（§4 的兜底是**显式写入偏好**，不是惰性回退）。

## 2. 形态决策（brainstorming 结论）

| 维度 | 决策                                                       | 理由                                                                           |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 姿态 | **温和、可跳过的提示卡片**（非全屏向导、非首启自动开设置） | 读书不需要 AI，强制挡路会烦到只想读书的用户                                    |
| 形态 | **进度清单卡片**（实时反映真实配置状态，配齐即消失）       | 既给「读书优先」的退路，又把藏在设置里、用户根本不知道的「自动摘要」显式摆出来 |
| 步骤 | **2 步·按结果**（连接 AI 模型 / 开启自动摘要）             | 不向用户暴露「对话模型与摘要模型是两套」这个内部坑                             |
| 位置 | **仅书库视图**，内容区顶部（最近阅读 / 书格之上）          | 首个落地面；阅读页不打扰                                                       |

## 3. 关键架构事实（实现据此）

- **配 key ≠ AI 能用**：填 provider 密钥后系统不自动选模型。对话需 `assistant` 显式 `providerId+model`（`getDefaultAssistant` / `resolveAssistantModel`），摘要需独立的 `summaryModel` 偏好（`resolveSummaryModel`）。
- **内置 DeepSeek 已存在但无 key**：`DEFAULT_PROVIDERS` 启动补齐一个 `isBuiltin` DeepSeek，`keyMask: null`。所以「连接模型」= 给某 provider 填 key + 选模型。
- **目前无任何首启标记**：需新增一个 `onboardingDismissed` 偏好（§5）。
- 渲染层已有可派生「步骤①完成」的全部数据，**无需新 IPC**：
  - `window.api.settings.assistant.getDefault()` → `{ providerId, model }`（query key `qk.assistantDefault`）
  - `window.api.settings.providers.list()` → `ProviderDto[]`（含 `keyMask`，query key `qk.providers`）
- 深链设置：`useSettingsStore` 的 `setActiveCategory("models")` + `setOpen(true)`。
- 自动摘要开关 = `usePrefsStore.autoSummarize` + `setAutoSummarize`（落盘 `autoSummarize` 偏好）。

## 4. 行为规格

### 4.1 步骤完成判定（纯派生，单一源）

抽成纯函数放 `src/renderer/library/onboarding-logic.ts`（可单测，遵循「纯核心 + 消费侧」模式）：

```ts
// 步骤①：对话模型已连接 = 助手有 provider+model 且该 provider 已配密钥
isModelConnected(assistant: { providerId, model } | undefined, providers: ProviderDto[]): boolean
// 步骤②：autoSummarize === true
// 全部完成：
isOnboardingComplete(modelConnected: boolean, autoSummarize: boolean): boolean
// summaryModel 兜底取值（步骤②开启时调用）：current 为空且助手模型齐全→返回 {providerId, model}，否则 null
summaryModelBackfill(current: SummaryModel | null, assistant: { providerId, model }): SummaryModel | null
```

### 4.2 卡片可见性

`show = !onboardingDismissed && !complete`

- 全新用户：`dismissed=false` 且未完成 → 显示。
- 完成（卡片内或设置页任一路径达成）→ `complete=true` → 隐藏（不残留满勾卡片）。
- 显式跳过（× 或「以后再说」）→ 写 `onboardingDismissed=true` → 隐藏。
- **不引入反应式 effect** 去「完成时持久化 dismissed」（避免 effect 模拟事件）。代价：若用户先配齐、之后又在设置里关掉自动摘要，卡片会重新出现——可接受（可再次手动跳过）。卡片内开启动作另行持久化 dismissed（§4.4），覆盖最常见路径。

### 4.3 步骤① 交互

- 未完成：行尾「去配置 →」按钮 → `setActiveCategory("models"); setOpen(true)` 打开设置→模型。用户在设置里填密钥 + 选对话模型；关闭设置后卡片随 query 失效自动重渲，打勾。
- 完成：✓ 勾选、标题划掉。

### 4.4 步骤② 交互（含 summaryModel 兜底）

- **步骤①未完成时锁定**：toggle 禁用、提示「先完成上一步」。保证兜底时对话模型一定存在，且杜绝「开了开关却没模型 → 静默失败」。
- 解锁后用户点开（事件处理里命令式完成，非 effect）：
  ```
  onEnableAutoSummary():
    const bf = summaryModelBackfill(summaryModel, assistant)
    if (bf) setSummaryModel(bf)        // 显式写入偏好，填那个隐藏缝
    setAutoSummarize(true)
    setOnboardingDismissed(true)        // 此刻两步齐全 → 持久化跳过，杜绝日后回弹
  ```
- 卡片内 toggle 实际只承担 OFF→ON（ON 即 complete、卡片已隐藏，关闭只能去设置页）。

### 4.5 空书库共存

空库时卡片在顶部，下方仍显示既有「书库为空，导入书籍」空状态（两者互补：一个讲 AI、一个讲导入）。

## 5. 新增偏好 `onboardingDismissed`

`boolean`，默认 `false`。四处同步注册（遵循 `preferences-set-switch-exhaustiveness`）：

1. `src/shared/preferences.ts`：`PREFERENCE_SCHEMAS.onboardingDismissed = z.boolean()` + `setPreferenceInput` 判别联合补一臂。
2. `src/main/ipc/preferences-handlers.ts`：switch 补 `case "onboardingDismissed"`（否则 `never` 守卫编译报错）。
3. `src/renderer/store/prefs-store.ts`：state `onboardingDismissed` + action `setOnboardingDismissed`（经 `persistPreference` 落盘）+ `PREFS_INITIAL`。
4. `src/renderer/store/hydrate-preferences.ts`：`if (snap.onboardingDismissed !== undefined) setState(...)`。
5. `src/shared/preferences.test.ts`：保持 schema ↔ input 同步断言绿。

## 6. 组件与文件

| 文件                                            | 角色                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/renderer/library/onboarding-logic.ts`      | 纯逻辑：`isModelConnected` / `isOnboardingComplete` / `summaryModelBackfill`（注入数据，无 React/Electron） |
| `src/renderer/library/onboarding-logic.test.ts` | vitest 单测：完成判定边界 + 兜底取值                                                                        |
| `src/renderer/library/OnboardingCard.tsx`       | 卡片 UI：wiring 两个 query + prefs + settings store；渲染两步、锁定、× 跳过                                 |
| `src/renderer/library/LibraryView.tsx`          | 在 ScrollArea `<main>` 顶部（`RecentlyReadShelf` 之上）挂 `<OnboardingCard />`                              |
| i18n（`src/shared/i18n/locales/{zh-CN,en}.ts`） | 新增 `onboarding.*` 文案；改完跑 `pnpm i18n:extract`                                                        |

样式遵循项目规范：Tailwind 工具类（`bg-card`/`border-border`/`font-serif` 等），不内联 CSS。React Compiler 已启用，不手写 `useCallback/useMemo`。

## 7. 测试策略

- **纯逻辑**（headless vitest）：`onboarding-logic.test.ts` 覆盖——无 provider / 有 provider 无 key / provider 有 key 但助手没选模型 / 全齐 → `isModelConnected`；`summaryModelBackfill` 在 current 空/非空两态。
- **偏好同步**：`preferences.test.ts` 绿（新 key 双向注册）。
- **手动冒烟**（dev，`--user-data-dir` 隔离）：全新库 → 卡片现身且第②步锁定 → 设置里配 DeepSeek key+模型 → 关设置卡片步骤①打勾、第②步解锁 → 点开自动摘要 → 卡片消失，sqlite 查 `onboardingDismissed=1` 且 `summaryModel` 已落同一模型。

## 8. 延后 / 非本 issue

- 设置页 `SummaryModelPicker` 在 `summaryModel` 未配置时默认显示对话模型——能更普遍地堵住「设置页直接开自动摘要却没配摘要模型」的缝，但属设置页行为、不在 onboarding 范围，记为后续 follow-up。
- 多 Assistant / 多模型选择的引导（Phase 1 仅单 Assistant）。
