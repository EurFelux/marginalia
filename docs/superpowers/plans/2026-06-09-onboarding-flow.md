# Onboarding / Landing Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在书库视图顶部加一张温和可跳过的「开启 AI 阅读伴侣」进度清单卡片，引导新用户连接 AI 模型并开启自动章节摘要，配齐即消失。

**Architecture:** 纯派生 + 消费侧 wiring。完成态从既有 `qk.providers` / `qk.assistantDefault` query 派生（无新 IPC）；可见性/跳过用新偏好 `onboardingDismissed`。「开启自动摘要」在事件处理里命令式完成：顺手把空的 `summaryModel` 兜底为对话模型（不改 `resolveSummaryModel` 的「绝不回退」契约）。判定/兜底逻辑抽成纯函数单测。

**Tech Stack:** React 19（启用 React Compiler，勿手写 useMemo/useCallback）、TanStack Query、Zustand（prefs-store）、Zod 4（preferences schema）、i18next（扁平 key，keySeparator false）、Tailwind、vitest（headless，仅测纯逻辑）。

**Spec:** `docs/superpowers/specs/2026-06-09-onboarding-flow-design.md`

---

## 文件结构

| 文件                                            | 责任                                                                    | 动作                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `src/renderer/library/onboarding-logic.ts`      | 纯逻辑：完成判定 + summaryModel 兜底取值（注入数据，无 React/Electron） | Create               |
| `src/renderer/library/onboarding-logic.test.ts` | vitest 单测                                                             | Create               |
| `src/renderer/library/OnboardingCard.tsx`       | 卡片 UI + wiring（query + prefs + settings store）                      | Create               |
| `src/renderer/library/LibraryView.tsx`          | 在 `<main>` 顶部挂 `<OnboardingCard />`                                 | Modify               |
| `src/shared/preferences.ts`                     | 注册 `onboardingDismissed` schema + input 判别臂                        | Modify               |
| `src/shared/preferences.test.ts`                | 更新 key 同步断言 + 补 value 校验                                       | Modify               |
| `src/main/ipc/preferences-handlers.ts`          | switch 补 `onboardingDismissed` case（never 守卫）                      | Modify               |
| `src/renderer/store/prefs-store.ts`             | state + action + 初值                                                   | Modify               |
| `src/renderer/store/hydrate-preferences.ts`     | 启动 hydrate 新 key                                                     | Modify               |
| `src/shared/i18n/locales/{en,zh-CN}.ts`         | `onboarding.*` 文案                                                     | Modify（经 extract） |

---

## Task 1: 纯逻辑模块 onboarding-logic（TDD）

**Files:**

- Create: `src/renderer/library/onboarding-logic.ts`
- Test: `src/renderer/library/onboarding-logic.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/library/onboarding-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ProviderDto } from "@shared/providers";
import { isModelConnected, isOnboardingComplete, summaryModelBackfill } from "./onboarding-logic";

function provider(over: Partial<ProviderDto> = {}): ProviderDto {
  return {
    id: "p1",
    type: "openai-chat-completions",
    compatibleApis: ["openai-chat-completions"],
    label: "P1",
    baseUrl: "https://x",
    keyMask: "sk-…1234",
    models: ["m1"],
    isBuiltin: false,
    createdAt: 0,
    ...over,
  };
}

describe("isModelConnected", () => {
  it("false when assistant undefined", () => {
    expect(isModelConnected(undefined, [provider()])).toBe(false);
  });
  it("false when assistant has no provider or model", () => {
    expect(isModelConnected({ providerId: null, model: null }, [provider()])).toBe(false);
    expect(isModelConnected({ providerId: "p1", model: null }, [provider()])).toBe(false);
  });
  it("false when the chosen provider has no key", () => {
    expect(isModelConnected({ providerId: "p1", model: "m1" }, [provider({ keyMask: null })])).toBe(
      false,
    );
  });
  it("false when the chosen provider is missing from the list", () => {
    expect(isModelConnected({ providerId: "ghost", model: "m1" }, [provider()])).toBe(false);
  });
  it("true when provider+model selected and that provider has a key", () => {
    expect(isModelConnected({ providerId: "p1", model: "m1" }, [provider()])).toBe(true);
  });
});

describe("isOnboardingComplete", () => {
  it("requires both model connected and auto-summarize on", () => {
    expect(isOnboardingComplete(false, false)).toBe(false);
    expect(isOnboardingComplete(true, false)).toBe(false);
    expect(isOnboardingComplete(false, true)).toBe(false);
    expect(isOnboardingComplete(true, true)).toBe(true);
  });
});

describe("summaryModelBackfill", () => {
  it("returns null when summaryModel already set (don't clobber)", () => {
    expect(
      summaryModelBackfill({ providerId: "x", model: "y" }, { providerId: "p1", model: "m1" }),
    ).toBeNull();
  });
  it("returns the assistant model when summaryModel unset", () => {
    expect(summaryModelBackfill(null, { providerId: "p1", model: "m1" })).toEqual({
      providerId: "p1",
      model: "m1",
    });
  });
  it("returns null when assistant model incomplete", () => {
    expect(summaryModelBackfill(null, { providerId: "p1", model: null })).toBeNull();
    expect(summaryModelBackfill(null, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/library/onboarding-logic.test.ts`
Expected: FAIL — `Cannot find module './onboarding-logic'`（或 export 未定义）。

- [ ] **Step 3: 写最小实现**

Create `src/renderer/library/onboarding-logic.ts`:

```ts
import type { SummaryModel } from "@shared/preferences";
import type { ProviderDto } from "@shared/providers";

/** 助手当前选中的 provider/model（从 AssistantDto 投影）。 */
type AssistantSelection = { providerId: string | null; model: string | null };

/** 步骤①完成：助手已选 provider+model，且该 provider 已配密钥（keyMask 非空）。 */
export function isModelConnected(
  assistant: AssistantSelection | undefined,
  providers: ProviderDto[] | undefined,
): boolean {
  if (!assistant?.providerId || !assistant.model) return false;
  const provider = providers?.find((p) => p.id === assistant.providerId);
  return provider != null && provider.keyMask != null;
}

/** onboarding 全部完成 = 模型已连接 且 自动摘要已开。 */
export function isOnboardingComplete(modelConnected: boolean, autoSummarize: boolean): boolean {
  return modelConnected && autoSummarize;
}

/**
 * 开启自动摘要时的 summaryModel 兜底取值（显式写入偏好，不动 resolveSummaryModel 的「绝不回退」契约）：
 *  - 已配 → null（不覆盖用户选择）
 *  - 未配且助手模型齐全 → 助手 (providerId, model)
 *  - 助手模型不全 → null（step2 锁定保证不会发生，防御性兜底）
 */
export function summaryModelBackfill(
  current: SummaryModel | null,
  assistant: AssistantSelection | undefined,
): SummaryModel | null {
  if (current) return null;
  if (!assistant?.providerId || !assistant.model) return null;
  return { providerId: assistant.providerId, model: assistant.model };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/library/onboarding-logic.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/library/onboarding-logic.ts src/renderer/library/onboarding-logic.test.ts
git commit -m "feat(onboarding): add pure logic for step completion & summary backfill"
```

---

## Task 2: 注册 onboardingDismissed 偏好（TDD）

**Files:**

- Modify: `src/shared/preferences.test.ts`
- Modify: `src/shared/preferences.ts`
- Modify: `src/main/ipc/preferences-handlers.ts`
- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`

- [ ] **Step 1: 先改测试（使其失败）**

在 `src/shared/preferences.test.ts` 的 `registers exactly the keys` 用例里，把期望数组加入 `"onboardingDismissed"`（按字母序在 `lastHighlightStyle` 与 `pdfZoom` 之间）：

```ts
it("registers exactly the keys with current consumers", () => {
  expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
    "autoSummarize",
    "colorMode",
    "language",
    "lastHighlightStyle",
    "onboardingDismissed",
    "pdfZoom",
    "readerLayout",
    "readerPrefs",
    "stepLimit",
    "summaryModel",
  ]);
});
```

并在 `setPreferenceInput validates value per key at the boundary` 用例末尾补两行：

```ts
expect(setPreferenceInput.safeParse({ key: "onboardingDismissed", value: true }).success).toBe(
  true,
);
expect(setPreferenceInput.safeParse({ key: "onboardingDismissed", value: "yes" }).success).toBe(
  false,
);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: FAIL —「registers exactly the keys」断言不匹配（缺 onboardingDismissed），以及 onboardingDismissed 校验 key 未知。

- [ ] **Step 3: 注册 schema（`src/shared/preferences.ts`）**

在 `PREFERENCE_SCHEMAS` 对象里加一行（放在 `summaryModel` 附近即可）：

```ts
  autoSummarize: z.boolean(),
  onboardingDismissed: z.boolean(),
```

在 `setPreferenceInput` 判别联合数组里补一臂（紧挨 autoSummarize 臂）：

```ts
  z.object({ key: z.literal("autoSummarize"), value: z.boolean() }),
  z.object({ key: z.literal("onboardingDismissed"), value: z.boolean() }),
```

- [ ] **Step 4: 补主进程 handler case（`src/main/ipc/preferences-handlers.ts`）**

在 switch 里 `autoSummarize` case 后补（否则末尾 `never` 守卫编译报错）：

```ts
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
      case "onboardingDismissed":
        return setPreference(getDb(), input.key, input.value);
```

- [ ] **Step 5: 渲染层 store（`src/renderer/store/prefs-store.ts`）**

`PrefsState` 接口加字段：

```ts
/** AI 对话 agent 循环的多步上限；0 = 不限制。落盘记忆，重启恢复。 */
stepLimit: number;
/** 首启 onboarding 卡片已跳过/已完成（持久化，不再唠叨）。 */
onboardingDismissed: boolean;
```

`PrefsActions` 接口加 action：

```ts
  setStepLimit: (v: number) => void;
  setOnboardingDismissed: (v: boolean) => void;
```

`PREFS_INITIAL` 加初值：

```ts
  stepLimit: DEFAULT_STEP_LIMIT,
  onboardingDismissed: false,
```

store 创建器加 action 实现（放在 `setStepLimit` 后）：

```ts
  setOnboardingDismissed: (onboardingDismissed) => {
    persistPreference({ key: "onboardingDismissed", value: onboardingDismissed });
    set({ onboardingDismissed });
  },
```

- [ ] **Step 6: 启动 hydrate（`src/renderer/store/hydrate-preferences.ts`）**

在 `stepLimit` 那行后补：

```ts
if (snap.stepLimit !== undefined) usePrefsStore.setState({ stepLimit: snap.stepLimit });
if (snap.onboardingDismissed !== undefined) {
  usePrefsStore.setState({ onboardingDismissed: snap.onboardingDismissed });
}
```

- [ ] **Step 7: 跑测试 + typecheck 确认通过**

Run: `pnpm test src/shared/preferences.test.ts && pnpm typecheck`
Expected: PASS（偏好同步断言绿，never 守卫编译通过）。

- [ ] **Step 8: 提交**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts src/main/ipc/preferences-handlers.ts src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts
git commit -m "feat(onboarding): register onboardingDismissed preference"
```

---

## Task 3: OnboardingCard 组件 + 挂载书库

**Files:**

- Create: `src/renderer/library/OnboardingCard.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`

> 说明：本仓渲染层组件不写组件渲染测试（既有约定——仅纯逻辑单测，见 settings-logic.test / book-drop.test）。本任务靠 Task 1 的纯逻辑单测 + `pnpm typecheck` + Task 5 的手动冒烟保障。文案先内联中文 `t()` 默认值，Task 4 再 extract + 补英文。

- [ ] **Step 1: 写组件**

Create `src/renderer/library/OnboardingCard.tsx`:

```tsx
import { Check, Lock, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { cn } from "@renderer/lib/utils";
import { isModelConnected, isOnboardingComplete, summaryModelBackfill } from "./onboarding-logic";

/** 首启引导卡片：仅书库显示；连接 AI 模型 + 开启自动摘要两步，配齐或跳过即消失。 */
export function OnboardingCard() {
  const { t } = useTranslation();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
  });

  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const summaryModel = usePrefsStore((s) => s.summaryModel);
  const dismissed = usePrefsStore((s) => s.onboardingDismissed);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  const setSummaryModel = usePrefsStore((s) => s.setSummaryModel);
  const setOnboardingDismissed = usePrefsStore((s) => s.setOnboardingDismissed);

  const openSettings = useSettingsStore((s) => s.setOpen);
  const setCategory = useSettingsStore((s) => s.setActiveCategory);

  const modelConnected = isModelConnected(assistant.data, providers.data);
  const complete = isOnboardingComplete(modelConnected, autoSummarize);

  // 已跳过/已完成不显示；query 未就绪先不渲染，避免「未连接→已连接」闪烁。
  if (dismissed) return null;
  if (providers.isPending || assistant.isPending) return null;
  if (complete) return null;

  const onConfigureModel = () => {
    setCategory("models");
    openSettings(true);
  };

  // 开启自动摘要：命令式一次性完成（非 effect 模拟）。顺手兜底 summaryModel，并持久化 dismissed。
  const onEnableAutoSummary = () => {
    const backfill = summaryModelBackfill(summaryModel, assistant.data);
    if (backfill) setSummaryModel(backfill);
    setAutoSummarize(true);
    setOnboardingDismissed(true);
  };

  return (
    <section className="relative mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOnboardingDismissed(true)}
        aria-label={t("onboarding.skip", "以后再说")}
        className="absolute end-2 top-2 size-7 text-muted-foreground"
      >
        <X className="size-4" />
      </Button>

      <h2 className="mb-0.5 font-serif text-base text-foreground">
        {t("onboarding.title", "开启 AI 阅读伴侣")}
      </h2>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t(
          "onboarding.subtitle",
          "选中文字向 AI 提问、自动生成章节摘要。读书本身不需要这些——随时可跳过。",
        )}
      </p>

      {/* 步骤①：连接 AI 模型 */}
      <div className="flex items-center gap-3 py-1.5">
        <span
          className={cn(
            "flex size-[18px] flex-none items-center justify-center rounded-full border",
            modelConnected
              ? "border-transparent bg-emerald-600 text-white"
              : "border-muted-foreground/40",
          )}
        >
          {modelConnected && <Check className="size-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-sm",
              modelConnected ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {t("onboarding.step1.title", "连接 AI 模型")}
          </div>
          {!modelConnected && (
            <div className="text-[11px] text-muted-foreground">
              {t("onboarding.step1.hint", "填一个模型服务的密钥并选择对话模型")}
            </div>
          )}
        </div>
        {!modelConnected && (
          <Button variant="outline" size="sm" onClick={onConfigureModel}>
            {t("onboarding.step1.action", "去配置")}
          </Button>
        )}
      </div>

      {/* 步骤②：开启自动章节摘要（步骤①完成前锁定） */}
      <div className="flex items-center gap-3 border-t border-border/60 py-1.5">
        <span
          className={cn(
            "flex size-[18px] flex-none items-center justify-center rounded-full border",
            modelConnected
              ? "border-muted-foreground/40"
              : "border-dashed border-muted-foreground/40 text-muted-foreground/50",
          )}
        >
          {!modelConnected && <Lock className="size-2.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-sm",
              modelConnected ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {t("onboarding.step2.title", "开启自动章节摘要")}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {modelConnected
              ? t("onboarding.step2.hint", "打开时自动用对话模型作摘要模型")
              : t("onboarding.step2.locked", "先完成上一步")}
          </div>
        </div>
        <Checkbox
          checked={false}
          disabled={!modelConnected}
          onCheckedChange={(v) => {
            if (v) onEnableAutoSummary();
          }}
          aria-label={t("onboarding.step2.title", "开启自动章节摘要")}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 挂载到 LibraryView**

在 `src/renderer/library/LibraryView.tsx` 顶部 import 区加：

```ts
import { OnboardingCard } from "./OnboardingCard";
```

把 `<main className="p-6">` 内的第一个子节点改为先渲染卡片（`RecentlyReadShelf` 之上）：

```tsx
        <main className="p-6">
          <OnboardingCard />
          <RecentlyReadShelf onOpen={openBook} />
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS（无类型错误；`window.api.settings.assistant.getDefault` / `providers.list` 已存在）。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/library/OnboardingCard.tsx src/renderer/library/LibraryView.tsx
git commit -m "feat(onboarding): add library onboarding card with 2-step checklist"
```

---

## Task 4: i18n 文案（extract + 英文）

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`（extract 自动写）
- Modify: `src/shared/i18n/locales/en.ts`

> 顺序要点（见 memory `i18n-operational-gotchas`）：先有内联 `t()` 中文默认（Task 3 已写）→ `pnpm i18n:extract` 抽 key 同步主语言（en 会拿中文 fallback）→ **手动**把 en 的 onboarding 键改成英文 → `pnpm i18n:lint` 校验。**改完英文后别再 extract**（会用 fallback 反向覆盖）。

- [ ] **Step 1: 抽取 key**

Run: `pnpm i18n:extract`
Expected: `src/shared/i18n/locales/zh-CN.ts` 与 `en.ts` 新增 9 个 `onboarding.*` 键（en 暂为中文 fallback）。

- [ ] **Step 2: 写英文（`src/shared/i18n/locales/en.ts`）**

把新增的 `onboarding.*` 七个键改成英文（扁平 key，按字母序它们应聚在一起）：

```ts
  "onboarding.title": "Set up your AI reading companion",
  "onboarding.subtitle": "Ask the AI about selected text and auto-generate chapter summaries. Reading itself needs none of this — skip anytime.",
  "onboarding.step1.title": "Connect an AI model",
  "onboarding.step1.hint": "Add a model provider key and pick a chat model",
  "onboarding.step1.action": "Set up",
  "onboarding.step2.title": "Turn on auto chapter summaries",
  "onboarding.step2.hint": "Enabling reuses your chat model as the summary model",
  "onboarding.step2.locked": "Finish the step above first",
  "onboarding.skip": "Maybe later",
```

（注：实际键数 = 9，含 title/subtitle/step1.*×3/step2.*×3/skip。若 extract 生成的中文键与 Task 3 内联默认有差异，以内联默认为准，勿手改 zh-CN。）

- [ ] **Step 3: 校验**

Run: `pnpm i18n:lint`
Expected: 无缺漏报告（en/zh-CN 的 onboarding.\* 键齐全）。

> 注意 memory：`i18n:lint` 可能漏报，必要时 `grep -c "onboarding\." src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts` 人工核对两边键数一致。

- [ ] **Step 4: 提交**

```bash
git add src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts
git commit -m "i18n(onboarding): add onboarding card strings (en + zh-CN)"
```

---

## Task 5: 全量验证 + 手动冒烟 + changeset

**Files:**

- Create: `.changeset/<random-name>.md`

- [ ] **Step 1: 全量 gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三者全绿（onboarding-logic 与 preferences 测试通过）。

- [ ] **Step 2: 手动冒烟（全新 profile）**

用隔离的临时 userData 起 dev（dev 也吃 `--user-data-dir`，见 memory `dev-cdp-smoke-args-gotcha`；注意恰好一个 `--`）：

```bash
pnpm start -- --user-data-dir=/tmp/mg-onboarding-smoke
```

目视核对：

1. 全新书库 → 顶部出现「开启 AI 阅读伴侣」卡片，步骤①带「去配置」、步骤②锁定（🔒「先完成上一步」、checkbox 禁用）。
2. 点「去配置」→ 设置打开并停在「模型」分类；填 DeepSeek key + 选对话模型，关设置 → 卡片步骤①打勾、步骤②解锁。
3. 勾选步骤② → 卡片消失。
4. 重启 app（同一 `--user-data-dir`）→ 卡片不再出现。
5. （可选）查库确认落盘：
   ```bash
   sqlite3 /tmp/mg-onboarding-smoke/marginalia.db "SELECT key,value FROM preferences WHERE key IN ('onboardingDismissed','autoSummarize','summaryModel');"
   ```
   Expected: `onboardingDismissed` 与 `autoSummarize` 为 true；`summaryModel` 已落与对话模型同一 (providerId, model)。

- [ ] **Step 3: 写 changeset（用户向英文）**

Run: `pnpm changeset`，选 patch/minor，写一条英文条目，例如：

```md
---
"marginalia": minor
---

Add a gentle first-run onboarding card to the library that guides you to connect an AI model and turn on automatic chapter summaries. Skippable anytime; disappears once set up.
```

- [ ] **Step 4: 提交**

```bash
git add .changeset
git commit -m "chore(onboarding): add changeset"
```

---

## 收尾（实现完成后）

- 用 `superpowers:finishing-a-development-branch` 决定合并方式（本地 main rebase 线性，见 memory `local-main-rebase-linear-workflow`）。
- 合并后用 `kanban` skill 把 #25 挪到 Done（commit message 里写 `closes #25` 让 GitHub 自动关 issue → Projects 自动挪 Done，见 memory `kanban-auto-done-on-merge`）。
- 延后项（spec §8）：设置页 `SummaryModelPicker` 未配置时默认显示对话模型——单独 issue，不在本计划。

```

```
