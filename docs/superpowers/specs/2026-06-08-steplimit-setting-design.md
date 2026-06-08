# 可配置 stepLimit 设计

日期：2026-06-08
状态：已与用户对齐（2026-06-08），待实现
关联：GitHub issue #20（P1，`enhancement` / `area:ai` / `area:settings`）；来源 ROADMAP backlog（ma5-deferred #8）+ PDF-P2 冒烟观察

## 1. 背景与动机

AI 对话的 agent 多步循环上限当前**硬编码为 `5`**（`src/main/ai/send.ts` 的 `stopWhen: stepCountIs(stepLimit ?? 5)`，且 `SendDeps.stepLimit` 虽是可选参数却无人注入）。PDF 书的逐页 `readPage` 工具调用是纯工具步（不产生文本回复），很容易在读到第 5 步就被强制截断，AI 还没读完上下文就停。需要把这个上限暴露为用户可调的偏好。

关键认识：`stepCountIs(N)` 传给 `streamText` 的 `stopWhen` 是**步数上限**，不是固定跑满 N 步——模型生成完文本、不再请求工具就自然结束。因此提高默认值对简单问答几乎零副作用，只有真正需要多步工具的场景（PDF 逐页）才受益。

## 2. 决策摘要

| 决策点         | 结论                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 作用域         | **仅选区问 AI 的对话循环**（`runSend`）。`stepCountIs`/`stopWhen` 全仓只此一处；摘要/自动命名无工具循环，不涉及                                        |
| 持久化形态     | 全局单值偏好，跟随既有 `PREFERENCE_SCHEMAS` 注册表模式（非 per-provider）                                                                              |
| 数据编码       | `z.number().int().min(0)`，**约定 `0 = 不限制`**，`≥1 = 具体步数上限`                                                                                  |
| 默认值         | **`10`**（从硬编码 5 提高）；定义为 shared 常量 `DEFAULT_STEP_LIMIT`，主进程兜底与渲染层初值共用同一源                                                 |
| 「不限制」实现 | `stopWhen: () => false`（永不主动刹车），靠模型自然停止 + 用户手动 abort（停止按钮已存在）。**不**用 `stepCountIs(超大数)`——后者仍是有限刹车，语义不准 |
| 默认值真相源   | shared 常量而非 schema `.default()`——保持「`getPreference` 未存返回 null + 消费侧退默认」的既有约定一致                                                |
| UI 摆放        | 设置页 **advanced（高级）** 分类——偏技术的行为旋钮，普通用户无需碰；models 是 provider/模型配置、reading 是阅读体验，语义都不如 advanced 贴            |
| UI 控件        | 数字 `Input`（clamp 1–99）+「不限制」`Checkbox`；勾选 → 存 `0`、数字框灰禁。跟随 `ReadingSettings` 的「左 label + 右控件」范式                         |
| falsy 0 防护   | `0` 是合法值且 falsy：hydrate 守卫用 `!== undefined`、send 兜底用 `??`（**不用 `\|\|`**），否则「不限制」会被吞成默认值                                |

## 3. 数据流

```
渲染层 AdvancedSettings（数字 Input + 不限制 Checkbox）
  └→ usePrefsStore.setStepLimit(n)  ── n: 0=不限 | 1..99
       └→ persistPreference({ key: "stepLimit", value: n })
            └→ preferences:set IPC → preferences-handlers switch case
                 └→ setPreference(db, "stepLimit", n)  → preferences 表落盘

启动 hydrate：
  preload sendSync 快照 → hydratePreferences()
    └→ if (snap.stepLimit !== undefined) usePrefsStore.setState({ stepLimit })

消费（每次发送）：
  ai-handlers → makeSendDeps()
    └→ stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT
       └→ runSend → streamText stopWhen:
            limit === 0 ? () => false : stepCountIs(limit)
```

## 4. 改动清单

**共享契约**

- `src/shared/preferences.ts`
  - 新 schema `stepLimit = z.number().int().min(0)`
  - 注册进 `PREFERENCE_SCHEMAS`
  - 补 `setPreferenceInput` discriminated union 一条 arm
  - 导出常量 `export const DEFAULT_STEP_LIMIT = 10`

**主进程**

- `src/main/ipc/preferences-handlers.ts`：switch 补 `case "stepLimit"`（穷尽性 `never` 守卫会强制要求，否则编译报错）
- `src/main/ai/send-deps.ts`：`makeSendDeps` 注入 `stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT`
- `src/main/ai/send.ts`：`stopWhen` 改造——
  ```ts
  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;     // ?? 保住合法的 0
  // ...
  stopWhen: limit === 0 ? () => false : stepCountIs(limit),
  ```
  并把 `SendDeps.stepLimit` 的 JSDoc 默认值注释从 5 改为 10

**渲染层**

- `src/renderer/store/prefs-store.ts`：`PrefsState` 加 `stepLimit: number`（`PREFS_INITIAL` 初值 `DEFAULT_STEP_LIMIT`）；`PrefsActions` 加 `setStepLimit`（走 `persistPreference`）
- `src/renderer/store/hydrate-preferences.ts`：加 `if (snap.stepLimit !== undefined) usePrefsStore.setState({ stepLimit: snap.stepLimit })`
- `src/renderer/settings/AdvancedSettings.tsx`：新增设置项控件（标题 + 描述 + 数字 Input + 不限制 Checkbox）

**i18n**

- 新增 keys：`settings.advanced.stepLimit`（标题）、`settings.advanced.stepLimitDesc`（描述，含「不限制」风险提示）、`settings.advanced.stepLimitUnlimited`（复选框 label）
- 跑 `pnpm i18n:extract` 同步主语言

## 5. 测试策略（从简）

聚焦低成本的契约 / store 层，**不**为 `send` 的步数行为写复杂 mock-多步单测（用户确认从简，2026-06-08）：

- `src/shared/preferences.test.ts`：既有 `PREFERENCE_SCHEMAS` ↔ `setPreferenceInput` arm 同步断言自动覆盖新 key；补 `stepLimit` schema 接受 `0` 与正整数、拒负数 / 小数
- `src/renderer/store/prefs-store.test.ts`：`stepLimit` 字段默认值（`DEFAULT_STEP_LIMIT`）+ `setStepLimit` 触发 `persistPreference`
- `send.ts` 的 `stopWhen` 映射（`0 → () => false`、`≥1 → stepCountIs(limit)`）保持薄而显然的内联逻辑，靠 typecheck + 手动冒烟把关，不写 mock 多步单测

## 6. 边界与风险

- **falsy 0**：见决策摘要——hydrate `!== undefined`、send `??`。这是本设计最易踩的坑，测试需显式覆盖 `0`
- **「不限制」的代价**：模型若陷入工具调用循环，会持续消耗 token 直到用户手动 abort。UI 描述文案需明示这一点
- **UI clamp**：数字框只产出 `1..99`；`0` 仅经复选框产生，用户不直接面对 magic 0
- 旧库（无 `stepLimit` 记录）：`getPreference` 返回 null → 退 `DEFAULT_STEP_LIMIT=10`，无迁移负担

## 7. 交付

- 合并前写一条用户向英文 changeset（`pnpm changeset`）
- commit 末尾 `closes #20`
- 完成后 kanban 卡片挪 Done
