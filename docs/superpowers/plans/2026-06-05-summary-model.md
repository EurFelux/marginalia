# 独立摘要模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为章节摘要、全书摘要、会话自动命名引入独立可配置的「摘要模型」（preferences 存储、未设报错不回退），聊天链路零改动。

**Architecture:** `preferences` 表注册 `summaryModel` key（无 DB 迁移）；`resolveSummaryModel(db)` 与 `resolveAssistantModel` 并列复用 `ResolvedModel` 错误语义；`makeSummaryDeps` 改接、`SendDeps` 新增字段供 auto naming；设置页提取 `ModelPickerSection` 共享基件，新增 `SummaryModelPicker`，`testResult` 退役 store 单槽为基件本地状态。

**Tech Stack:** Electron 主进程 + Drizzle/better-sqlite3 + Zod 4 + React 19（React Compiler，勿手写 useCallback/useMemo）+ zustand + react-query + vitest。

**Spec:** `docs/superpowers/specs/2026-06-05-summary-model-design.md`

**分支：** 开工前自 main 建 `feat/summary-model`。

**全局约束：** 禁止 `git -C <dir>`；包管理用 `pnpm`/`pnpx`；提交信息 Conventional Commits；prek 钩子若以 "files were modified by this hook" 中止提交 → `git add` 被改文件后重跑同一条 commit 命令。

---

### Task 1: shared preferences 注册 `summaryModel`

**Files:**

- Modify: `src/shared/preferences.ts`
- Test: `src/main/preferences/repository.test.ts`（既有同步校验自动覆盖 + 补一条 roundtrip）

- [ ] **Step 1: 注册 schema、key 与 setPreferenceInput arm**

在 `src/shared/preferences.ts` 的 `readerLayoutSchema` 块之后（`PREFERENCE_SCHEMAS` 之前）加：

```ts
/** 摘要模型（章节/全书摘要 + 会话自动命名）：显式 (provider, model) 对；未存 = 未配置（报错态，无回退）。 */
export const summaryModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
export type SummaryModelPref = z.infer<typeof summaryModelSchema>;
```

`PREFERENCE_SCHEMAS` 加一行（`readerLayout` 之后）：

```ts
  summaryModel: summaryModelSchema,
```

`setPreferenceInput` 判别联合补一条 arm（`readerLayout` arm 之后）：

```ts
  z.object({ key: z.literal("summaryModel"), value: summaryModelSchema }),
```

- [ ] **Step 2: 补 roundtrip 测试**

打开 `src/main/preferences/repository.test.ts`，仿照现有 set/get 用例补一条（放在既有 describe 内；先读该文件确认 helper 命名，下面代码按 `repository.ts` 的导出写）：

```ts
it("roundtrips the summaryModel preference", () => {
  const db = freshDb(); // 沿用该文件现有的 fresh DB helper 名称
  setPreference(db, "summaryModel", { providerId: "p1", model: "claude-haiku-4-5" });
  expect(getPreference(db, "summaryModel")).toEqual({
    providerId: "p1",
    model: "claude-haiku-4-5",
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `pnpm test src/main/preferences/repository.test.ts`
Expected: PASS（该文件的「PREFERENCE_SCHEMAS 与 setPreferenceInput 同步」既有校验若存在也应绿——若它因新 key 报红说明两处没加齐，回 Step 1 补）。

- [ ] **Step 4: typecheck + commit**

```bash
pnpm typecheck
git add src/shared/preferences.ts src/main/preferences/repository.test.ts
git commit -m "feat(preferences): register summaryModel key"
```

---

### Task 2: `resolveSummaryModel(db)` + i18n 错误 key

**Files:**

- Modify: `src/main/ai/assistant-model.ts`
- Modify: `src/shared/i18n/locales/zh-CN.ts`、`src/shared/i18n/locales/en.ts`
- Test: `src/main/ai/assistant-model.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/ai/assistant-model.test.ts` 末尾追加（该文件已有 `freshDb` / `initMainI18n("en")` / `upsertProvider` 基建）：

```ts
import { setPreference } from "@main/preferences/repository";
import { resolveSummaryModel } from "@main/ai/assistant-model";

describe("resolveSummaryModel", () => {
  it("resolves when the preference points at a provider with a key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "anthropic",
      baseUrl: null,
      apiKey: "sk-test",
    });
    setPreference(db, "summaryModel", { providerId: provider.id, model: "claude-haiku-4-5" });
    const r = resolveSummaryModel(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe("claude-haiku-4-5");
  });

  it("fails when the preference is unset", () => {
    const db = freshDb();
    const r = resolveSummaryModel(db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("summary model");
  });

  it("fails when the referenced provider was deleted", () => {
    const db = freshDb();
    setPreference(db, "summaryModel", { providerId: "ghost", model: "m" });
    const r = resolveSummaryModel(db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("provider");
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, { type: "anthropic", baseUrl: null });
    setPreference(db, "summaryModel", { providerId: provider.id, model: "m" });
    const r = resolveSummaryModel(db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain("api key");
  });
});
```

注意：import 行合并进文件顶部既有 import 区（不要在文件中部 import）。`upsertProvider` 的入参形状以该文件现有用例为准（如必填 `baseUrl` 则传 `null` 或合法 URL）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: FAIL —— `resolveSummaryModel` 未导出。

- [ ] **Step 3: 实现 `resolveSummaryModel`**

在 `src/main/ai/assistant-model.ts` 末尾追加（import 区补 `import { getPreference } from "@main/preferences/repository";`）：

```ts
/**
 * 把「摘要模型」偏好解析为可调用模型（章节/全书摘要 + auto naming 共用；spec §4）。
 * 未配置 / provider 已删 / 无密钥一律返回结构化错误——显式报错，绝不回退聊天模型。
 */
export function resolveSummaryModel(db: DB): ResolvedModel {
  const pref = getPreference(db, "summaryModel");
  if (!pref) {
    return { ok: false, reason: t("errors.summaryModelNotConfigured", "未配置摘要模型") };
  }
  const provider = loadProvider(db, pref.providerId);
  if (!provider) {
    return {
      ok: false,
      reason: t("errors.assistantProviderNotFound", "未找到所配置的$t(terms.provider)"),
    };
  }
  if (!provider.apiKey) {
    return { ok: false, reason: t("errors.assistantNoApiKey", "$t(terms.provider)未设置密钥") };
  }
  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: pref.model,
    });
    return { ok: true, model, modelId: pref.model };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : t("errors.failedToBuildModel", "构建模型失败"),
    };
  }
}
```

- [ ] **Step 4: 加 i18n key（两个 locale 手工补，按字母序插入）**

`src/shared/i18n/locales/zh-CN.ts`（`errors.s*` 字母序位置）：

```ts
  "errors.summaryModelNotConfigured": "未配置摘要模型",
```

`src/shared/i18n/locales/en.ts`（同位置）：

```ts
  "errors.summaryModelNotConfigured": "Summary model is not configured",
```

注意先读 en.ts 中 `errors.assistantProviderNotFound` 与 `errors.assistantNoApiKey` 的实际英文文案，确认 Step 1 中 `toContain("provider")` / `toContain("api key")`（toLowerCase 后）断言成立；不成立则调整断言子串（以 locale 实际文案为准，不改文案迁就测试）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: PASS（全部 8 个用例：resolveAssistantModel 4 + resolveSummaryModel 4）。

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/assistant-model.ts src/main/ai/assistant-model.test.ts src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(ai): add resolveSummaryModel with explicit no-fallback errors"
```

---

### Task 3: send 链注入——摘要与起名走新解析器

**Files:**

- Modify: `src/main/ai/send.ts`（`SendDeps` 新字段 + onFinish 改传）
- Modify: `src/main/ai/send-deps.ts`（两个工厂改接）
- Test: `src/main/ai/send.test.ts`

- [ ] **Step 1: 写失败测试**

打开 `src/main/ai/send.test.ts`。该文件现有 fake deps 构造两处（约 L107 `const deps: SendDeps = { db, loadBytes, resolveModel: () => model };` 与 L126 同形）。本任务：

(a) 给**所有** `SendDeps` 字面量补 `resolveSummaryModel` 字段。默认值：`() => ({ ok: false, reason: "summary model unset" })`——这使既有 naming 测试会开始失败（它们此前依赖 `resolveModel` 同时服务起名），正是本任务要的红。

(b) 既有 naming 用例改造：把 `textStreamModelWithNaming(streamText, namingTitle)` 这种「单 model 兼营 doStream+doGenerate」拆成两个注入——聊天 model 只 `doStream`，naming model 只 `doGenerate`。在 mock 区新增：

```ts
/** 仅 doGenerate 的 mock（auto-naming 专用——naming 现走独立 resolveSummaryModel）。 */
function namingOnlyModel(namingTitle: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      content: [{ type: "text" as const, text: namingTitle }],
      warnings: [],
    }),
  });
}
```

既有「首轮完成自动命名」用例改为：

```ts
const chatModel = textStreamModel("回答正文"); // 该文件现有的纯 doStream mock；名称以实际为准
const deps: SendDeps = {
  db,
  loadBytes,
  resolveModel: () => ({ ok: true, model: chatModel, modelId: "chat-model" }),
  resolveSummaryModel: () => ({
    ok: true,
    model: namingOnlyModel("自动起的标题"),
    modelId: "summary-model",
  }),
};
```

（`resolveModel` 返回形状以该文件现有写法为准——若现有写法是 `() => model` 之类的包装 helper，沿用它。）

(c) 新增用例——summary resolver 未配置时起名跳过、聊天不受影响：

```ts
it("skips naming when the summary model is unconfigured; chat still completes", async () => {
  // 按该文件现有 naming 用例的 setup：建会话、构造 deps、runSend、await finished
  const deps: SendDeps = {
    db,
    loadBytes,
    resolveModel: () => ({ ok: true, model: textStreamModel("回答"), modelId: "chat-model" }),
    resolveSummaryModel: () => ({ ok: false, reason: "unset" }),
  };
  const result = runSend(deps, input);
  expect(result.ok).toBe(true);
  if (result.ok) await result.finished;
  await vi.waitFor(() => {
    // 起名被跳过：title 保持 null；assistant 消息照常 complete
    const convo = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .get();
    expect(convo?.title).toBeNull();
  });
});
```

（setup 细节——会话/书 fixture、`input` 构造、import——全部仿照该文件既有 naming 用例；不要发明新基建。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: FAIL —— `SendDeps` 尚无 `resolveSummaryModel` 字段（typecheck 红）；先让类型错误暴露。

- [ ] **Step 3: 实现 send.ts 改动**

`src/main/ai/send.ts` 的 `SendDeps`（L24-30）改为：

```ts
export interface SendDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /** 摘要模型解析器（auto naming 用；章节/全书摘要在 makeSummaryDeps 注入同一解析器）。 */
  resolveSummaryModel: () => ResolvedModel;
  /** agent 多步上限（默认 5）。 */
  stepLimit?: number;
}
```

L48 解构补字段：

```ts
const { db, loadBytes, resolveModel, resolveSummaryModel, stepLimit } = deps;
```

onFinish 内（L166-171）`nameConversation` 调用改传摘要解析器：

```ts
void nameConversation(
  { db, resolveModel: resolveSummaryModel },
  conversationId,
  input.userText,
  assistantText,
);
```

- [ ] **Step 4: 实现 send-deps.ts 改动**

`src/main/ai/send-deps.ts` 整体改为：

```ts
import { getBooksDir, getDb } from "@main/db/instance";
import { readEpubFile } from "@main/library/book-files";
import { resolveAssistantModel, resolveSummaryModel } from "@main/ai/assistant-model";
import type { SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";

/** (bookId) => 该书 app 自有 ePub 副本字节；缺失抛 EpubFileMissingError。注入 booksDir 以便单测。 */
export function createLoadBytes(booksDir: string): LoadBytes {
  return (bookId: string) => readEpubFile(booksDir, bookId);
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(getBooksDir());
  return {
    db,
    loadBytes,
    resolveModel: () => resolveAssistantModel(db),
    resolveSummaryModel: () => resolveSummaryModel(db),
  };
}

/** 章摘懒生成所需依赖（供 content:generate-chapter-summary handler 用）。摘要走独立摘要模型（spec §5）。 */
export function makeSummaryDeps(): SummaryDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(getBooksDir()),
    resolveModel: () => resolveSummaryModel(db),
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/ai/send.test.ts && pnpm typecheck`
Expected: PASS。若有其他文件构造 `SendDeps`（grep `makeSendDeps\|SendDeps` 确认——`ai-handlers.ts` 经 `makeSendDeps` 不受影响），一并修。

- [ ] **Step 6: 全量测试 + Commit**

```bash
pnpm test
git add -A src/main
git commit -m "feat(ai): route summaries and auto-naming through resolveSummaryModel"
```

---

### Task 4: renderer 偏好状态——prefs store 新槽 + hydrate

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`

（渲染层 store 无 headless 测试惯例——本任务靠 typecheck + 后续冒烟验证。）

- [ ] **Step 1: prefs-store 加槽**

`src/renderer/store/prefs-store.ts`：

import 区补：

```ts
import type { SummaryModelPref } from "@shared/preferences";
```

`PrefsState` 加字段（`autoSummarize` 之后）：

```ts
/** 摘要模型（章节/全书摘要 + 会话自动命名）；null = 未配置（生成报错/命名跳过，无回退）。 */
summaryModel: SummaryModelPref | null;
```

`PrefsActions` 加：

```ts
  setSummaryModel: (v: SummaryModelPref) => void;
```

`PREFS_INITIAL` 加：

```ts
  summaryModel: null,
```

store 工厂加 action（`setAutoSummarize` 之后，同构）：

```ts
  setSummaryModel: (summaryModel) => {
    persistPreference({ key: "summaryModel", value: summaryModel });
    set({ summaryModel });
  },
```

- [ ] **Step 2: hydrate 补一行**

`src/renderer/store/hydrate-preferences.ts` 的 `hydratePreferences` 内（`autoSummarize` 块之后）：

```ts
if (snap.summaryModel) usePrefsStore.setState({ summaryModel: snap.summaryModel });
```

- [ ] **Step 3: typecheck + Commit**

```bash
pnpm typecheck
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts
git commit -m "feat(renderer): summaryModel preference slot + hydrate"
```

---

### Task 5: `ModelPickerSection` 共享基件提取 + `AssistantModelPicker` 重构

**Files:**

- Create: `src/renderer/settings/ModelPickerSection.tsx`
- Modify: `src/renderer/settings/AssistantModelPicker.tsx`（变薄为数据接线）
- Modify: `src/renderer/store/settings-store.ts`（删 `testResult`/`setTestResult`）

行为目标：**对话模型区块外观与交互完全不变**；测试结果改为基件本地状态。

- [ ] **Step 1: 新建 ModelPickerSection**

`src/renderer/settings/ModelPickerSection.tsx`：

```tsx
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { assistantModelOptions } from "./settings-logic";

export interface ModelPickerSectionProps {
  title: string;
  /** 区块说明（可选；摘要模型用）。 */
  description?: string;
  /** "" = 未选。 */
  providerId: string;
  /** "" = 未选。 */
  model: string;
  /** 切 provider；调用方应同时弃旧 model（非法 (provider, model) 对防呆）。 */
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
}

/**
 * provider/model 双 Select + 测试连接的共享基件（对话模型 / 摘要模型两区块共用）。
 * 测试结果是基件本地状态（ProviderCard 同款取向）——两个区块天然隔离、互不覆盖。
 */
export function ModelPickerSection({
  title,
  description,
  providerId,
  model,
  onProviderChange,
  onModelChange,
}: ModelPickerSectionProps) {
  const { t } = useTranslation();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const selected = providers.data?.find((p) => p.id === providerId) ?? null;
  const modelOptions = assistantModelOptions(selected?.models ?? [], model || null);

  const test = useMutation({
    mutationFn: () => window.api.settings.providers.test({ id: providerId, model }),
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  const unnamed = t("settings.provider.unnamed", "（未命名）");

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("terms.provider")}</span>
        <Select
          value={providerId || null}
          onValueChange={(id) => {
            // 切 provider 同时由调用方清 model（旧 model 多半不属于新 provider）；换选后旧测试结果作废。
            if (id) {
              onProviderChange(id);
              setTestResult(null);
            }
          }}
        >
          <SelectTrigger className="h-9 w-full">
            {/* value 是 provider id（uuid）；Base UI Select.Value 默认渲染裸 value，故用函数 child 映射成名字。 */}
            <SelectValue placeholder={t("settings.provider.select", "选择$t(terms.provider)")}>
              {(value) =>
                typeof value === "string"
                  ? (providers.data?.find((p) => p.id === value)?.label ?? unnamed)
                  : t("settings.provider.select", "选择$t(terms.provider)")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label ?? unnamed}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{t("settings.model", "模型")}</span>
        <Select
          value={model || null}
          disabled={!providerId}
          onValueChange={(m) => {
            if (m) {
              onModelChange(m);
              setTestResult(null);
            }
          }}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue placeholder={t("settings.model.select", "选择模型")} />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!providerId || !model || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending
            ? t("settings.provider.testing", "测试中…")
            : t("settings.provider.test", "测试连接")}
        </Button>
        {testResult && (
          <span
            className={
              testResult.ok
                ? "flex items-center gap-1 text-sm text-primary"
                : "flex items-center gap-1 text-sm text-destructive"
            }
          >
            {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
            {testResult.ok
              ? t("settings.provider.testOk", "连接成功")
              : t("settings.provider.testFail", "失败：{{message}}", {
                  message: testResult.message ?? "",
                })}
          </span>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: AssistantModelPicker 变薄**

`src/renderer/settings/AssistantModelPicker.tsx` 整体替换为：

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { ModelPickerSection } from "./ModelPickerSection";

export function AssistantModelPicker() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
  });

  const save = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string | null }) =>
      window.api.settings.assistant.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assistantDefault }),
  });

  return (
    <ModelPickerSection
      title={t("settings.assistantModel", "对话模型")}
      providerId={assistant.data?.providerId ?? ""}
      model={assistant.data?.model ?? ""}
      onProviderChange={(id) => save.mutate({ providerId: id, model: null })}
      onModelChange={(m) => save.mutate({ model: m })}
    />
  );
}
```

- [ ] **Step 3: settings-store 删 testResult**

`src/renderer/store/settings-store.ts` 整体替换为：

```ts
import { create } from "zustand";

export type SettingsCategory = "models" | "appearance" | "reading";

interface SettingsState {
  open: boolean;
  activeCategory: SettingsCategory;
}
interface SettingsActions {
  setOpen: (open: boolean) => void;
  setActiveCategory: (c: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  activeCategory: "models",
  setOpen: (open) => set({ open }),
  setActiveCategory: (activeCategory) => set({ activeCategory }),
}));
```

确认无残留消费者：`grep -rn "testResult\|setTestResult" src/renderer --include="*.ts*"` 应只剩 ProviderCard 的注释提及（改注释为「不写共享状态」或保留原文均可——若注释引用已删字段名造成误导，顺手更新）。

- [ ] **Step 4: 验证 + Commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/renderer/settings/ModelPickerSection.tsx src/renderer/settings/AssistantModelPicker.tsx src/renderer/store/settings-store.ts
git commit -m "refactor(settings): extract ModelPickerSection; local test-result state"
```

---

### Task 6: `SummaryModelPicker` + 挂载 + i18n 收口

**Files:**

- Create: `src/renderer/settings/SummaryModelPicker.tsx`
- Modify: `src/renderer/settings/ModelsSettings.tsx`
- Modify: locales（经 `pnpm i18n:extract` + 手补 en 文案）

- [ ] **Step 1: 新建 SummaryModelPicker**

`src/renderer/settings/SummaryModelPicker.tsx`：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { ModelPickerSection } from "./ModelPickerSection";

/**
 * 摘要模型区块（章节/全书摘要 + 会话自动命名；spec §6）。
 * 偏好是原子 (provider, model) 对——切 provider 后的中间态（model 未选）不可落盘，
 * 故 draft 持本地，选定 model 才 setSummaryModel 原子落盘。
 */
export function SummaryModelPicker() {
  const { t } = useTranslation();
  const stored = usePrefsStore((s) => s.summaryModel);
  const setSummaryModel = usePrefsStore((s) => s.setSummaryModel);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);

  const providerId = draftProvider ?? stored?.providerId ?? "";
  const model = draftProvider != null ? "" : (stored?.model ?? "");

  return (
    <ModelPickerSection
      title={t("settings.summaryModel", "摘要模型")}
      description={t("settings.summaryModel.desc", "用于章节/全书摘要与会话自动命名")}
      providerId={providerId}
      model={model}
      onProviderChange={setDraftProvider}
      onModelChange={(m) => {
        if (!providerId) return;
        setSummaryModel({ providerId, model: m });
        setDraftProvider(null);
      }}
    />
  );
}
```

- [ ] **Step 2: ModelsSettings 挂载**

`src/renderer/settings/ModelsSettings.tsx`：import 区补 `import { SummaryModelPicker } from "./SummaryModelPicker";`，JSX 中 `<AssistantModelPicker />` 之后加一行 `<SummaryModelPicker />`。

- [ ] **Step 3: i18n extract + en 补全**

```bash
pnpm i18n:extract
```

然后检查 `src/shared/i18n/locales/en.ts`：新 key `settings.summaryModel` / `settings.summaryModel.desc` 若被 extract 置空或缺失，手工补：

```ts
  "settings.summaryModel": "Summary Model",
  "settings.summaryModel.desc": "Used for chapter/book summaries and conversation auto-naming",
```

同时 grep 验证 Task 2 的 `errors.summaryModelNotConfigured` 在两个 locale 仍存活（extract 不应删主进程 key；若被删则恢复并排查——参考 i18n 坑 memory：`i18n:lint` 会漏报，以 grep 为准）：

```bash
grep -rn "summaryModelNotConfigured\|settings.summaryModel" src/shared/i18n/locales/
```

Expected: zh-CN.ts 与 en.ts 各 3 个 key 齐全。

- [ ] **Step 4: 全量验证 + Commit**

```bash
pnpm i18n:extract && pnpm typecheck && pnpm lint && pnpm test
git add -A src/renderer/settings src/shared/i18n
git commit -m "feat(settings): summary model picker section"
```

Expected: 测试全绿（基线 382+ 个）。

---

## 完成后（流程级，不属于任务）

1. 最终全量代码评审（subagent-driven 流程收尾）。
2. CDP 真启动冒烟（dev userData 副本 + `--user-data-dir`/`--remote-debugging-port`，恰好一个 `--`）：
   - 未配置摘要模型 → 摘要 pill 手动生成 → toast「未配置摘要模型」；发消息后起名跳过、标题保持「未命名会话」占位；
   - 设置页配置摘要模型（与对话模型同 provider、选轻量 model）→ `sqlite3 <dev-copy>/marginalia.db "select value from preferences where key='summaryModel'"` 确认落盘；
   - 配置后生成章节摘要 → pill 转 ready；新会话发消息 → 自动起名出现；
   - 对话模型区块行为回归（外观/测试连接不变）。
3. `pnpm changeset`（minor，用户向英文条目）→ 合并 main → 更新 ROADMAP（backlog「独立『摘要模型』设置」行打 ✅ + 交付段落）。
