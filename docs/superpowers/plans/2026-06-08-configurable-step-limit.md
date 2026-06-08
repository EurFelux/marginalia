# Configurable stepLimit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the AI conversation agent's step cap as a user preference (default 10, range 1–99, or "unlimited"), replacing the hardcoded `5` in `runSend`.

**Architecture:** New `stepLimit` preference follows the existing `PREFERENCE_SCHEMAS` registry pattern (shared Zod source → main-process consumer + renderer store). Encoded as `z.number().int().min(0)` where `0 = unlimited`. `makeSendDeps` reads it and injects into `runSend`, which maps it to `streamText`'s `stopWhen` (`0 → () => false`, `≥1 → stepCountIs(limit)`). UI is a number input + "unlimited" checkbox in the Advanced settings tab.

**Tech Stack:** Zod 4, Drizzle (preferences table), Vercel AI SDK v6 (`stepCountIs`/`stopWhen`), React 19 + zustand store, Base UI Input/Checkbox, i18next (zh-CN primary + en).

**Spec:** `docs/superpowers/specs/2026-06-08-steplimit-setting-design.md`

**Conventions:**

- Run tests with `pnpm test <file>` (vitest on Electron runtime). Typecheck with `pnpm typecheck`.
- Commit messages: Conventional Commits. End each with the `Co-Authored-By` trailer used in this repo.
- pre-commit hook runs `lint:fix` + `format`; if it modifies files, re-`git add` and re-run the same commit (second pass passes).

---

### Task 1: Shared contract — `stepLimit` schema, default constant, IPC arm

**Files:**

- Modify: `src/shared/preferences.ts`
- Test: `src/shared/preferences.test.ts`

- [ ] **Step 1: Update the tests to expect the new key (write failing test)**

In `src/shared/preferences.test.ts`, the `registers exactly the keys` test lists all keys — add `"stepLimit"` in sorted position (between `readerPrefs` and `summaryModel`):

```ts
it("registers exactly the keys with current consumers", () => {
  expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
    "autoSummarize",
    "colorMode",
    "language",
    "lastHighlightStyle",
    "pdfZoom",
    "readerLayout",
    "readerPrefs",
    "stepLimit",
    "summaryModel",
  ]);
});
```

Add a new test after the `language preference` describe block (end of file):

```ts
describe("stepLimit preference", () => {
  it("accepts 0 (unlimited) and positive ints, rejects negatives/floats", () => {
    expect(setPreferenceInput.safeParse({ key: "stepLimit", value: 0 }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "stepLimit", value: 10 }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "stepLimit", value: -1 }).success).toBe(false);
    expect(setPreferenceInput.safeParse({ key: "stepLimit", value: 3.5 }).success).toBe(false);
    expect(setPreferenceInput.safeParse({ key: "stepLimit", value: "5" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: FAIL — `registers exactly the keys` mismatch (no `stepLimit`), and `setPreferenceInput` rejects the `stepLimit` key (unknown).

- [ ] **Step 3: Add the schema, constant, registry entry, and IPC arm**

In `src/shared/preferences.ts`, add the schema + constant just before `PREFERENCE_SCHEMAS` (after the `summaryModelSchema`/`pdfZoomSchema` block, around line 39):

```ts
/** AI 对话 agent 循环的多步上限。0 = 不限制（永不主动刹车，仅靠模型自然停止 + 用户 abort）；≥1 = 具体步数上限。 */
export const stepLimitSchema = z.number().int().min(0);

/** stepLimit 缺省值：主进程兜底（makeSendDeps / runSend）与渲染层初值共用单一源。 */
export const DEFAULT_STEP_LIMIT = 10;
```

Register it in `PREFERENCE_SCHEMAS` (add the last entry):

```ts
export const PREFERENCE_SCHEMAS = {
  readerPrefs: readerPrefsSchema,
  lastHighlightStyle: annotationStyle,
  autoSummarize: z.boolean(),
  colorMode,
  language: uiLanguage,
  readerLayout: readerLayoutSchema,
  summaryModel: summaryModelSchema,
  pdfZoom: pdfZoomSchema,
  stepLimit: stepLimitSchema,
} as const;
```

Add the discriminated-union arm in `setPreferenceInput` (after the `pdfZoom` arm):

```ts
  z.object({ key: z.literal("stepLimit"), value: stepLimitSchema }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: PASS (all, including the new `stepLimit preference` describe).

- [ ] **Step 5: Commit**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts
git commit -m "feat(ai): add stepLimit preference schema and default

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Main-process wiring — handler case, deps injection, stopWhen mapping

**Files:**

- Modify: `src/main/ipc/preferences-handlers.ts`
- Modify: `src/main/ai/send-deps.ts`
- Modify: `src/main/ai/send.ts`

No new unit test (test strategy is simplified per spec §5; the exhaustiveness `never` guard + typecheck enforce correctness here).

- [ ] **Step 1: Add the handler switch case**

In `src/main/ipc/preferences-handlers.ts`, add the case after `case "pdfZoom":` and before `default:`:

```ts
      case "stepLimit":
        return setPreference(getDb(), input.key, input.value);
```

(Without this, the `never` exhaustiveness guard fails to compile — that is the safety net.)

- [ ] **Step 2: Inject stepLimit in makeSendDeps**

In `src/main/ai/send-deps.ts`, add imports at the top (alongside existing imports):

```ts
import { getPreference } from "@main/preferences/repository";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
```

Update `makeSendDeps` to inject the preference (falling back to the default):

```ts
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(appService.getPath("booksDir"), db);
  const resolveModel = () => resolveAssistantModel(db);
  return {
    db,
    loadBytes,
    resolveModel,
    resolveSummaryModel: () => resolveSummaryModel(db),
    stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT,
  };
}
```

- [ ] **Step 3: Map stepLimit to stopWhen in send.ts**

In `src/main/ai/send.ts`, add the import (after the existing `@shared/chat` import, ~line 23):

```ts
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
```

Update the `SendDeps.stepLimit` JSDoc (~line 35) to document the new semantics:

```ts
  /** agent 多步上限（默认 DEFAULT_STEP_LIMIT=10）；0 = 不限制（永不主动刹车，靠模型自然停止 + abort）。 */
  stepLimit?: number;
```

Just before the `streamText({ ... })` call (it begins ~line 122), compute the resolved limit:

```ts
const limit = stepLimit ?? DEFAULT_STEP_LIMIT; // ?? 不用 ||——保住合法的 0（不限制）
```

Then change the `stopWhen` line (currently `stopWhen: stepCountIs(stepLimit ?? 5),`) to:

```ts
    stopWhen: limit === 0 ? () => false : stepCountIs(limit),
```

(`() => false` is a `StopCondition` that never trips — the agent loop ends only when the model stops requesting tools or the user aborts. The no-arg arrow is assignable to the SDK's `(options) => boolean` signature.)

- [ ] **Step 4: Verify typecheck + existing send tests still pass**

Run: `pnpm typecheck`
Expected: PASS (no errors; the exhaustiveness guard is satisfied).

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS (existing tests untouched; default behavior preserved — they don't inject stepLimit, so they fall back to `DEFAULT_STEP_LIMIT`, still a finite `stepCountIs`).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/preferences-handlers.ts src/main/ai/send-deps.ts src/main/ai/send.ts
git commit -m "feat(ai): wire configurable stepLimit into the send loop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Renderer store — prefs-store field/action + hydrate

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`
- Test: `src/renderer/store/prefs-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/renderer/store/prefs-store.test.ts`, add `DEFAULT_STEP_LIMIT` to the imports:

```ts
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
```

Add two tests inside the `describe("prefs-store", ...)` block:

```ts
it("setStepLimit updates value and persists", () => {
  usePrefsStore.getState().setStepLimit(0);
  expect(usePrefsStore.getState().stepLimit).toBe(0);
  expect(persistPreference).toHaveBeenCalledWith({ key: "stepLimit", value: 0 });
});
it("stepLimit defaults to DEFAULT_STEP_LIMIT", () => {
  expect(PREFS_INITIAL.stepLimit).toBe(DEFAULT_STEP_LIMIT);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: FAIL — `setStepLimit` is not a function / `PREFS_INITIAL.stepLimit` is undefined.

- [ ] **Step 3: Add the field, action, and initial value**

In `src/renderer/store/prefs-store.ts`, change the `SummaryModel` import to also bring in the constant:

```ts
import { DEFAULT_STEP_LIMIT, type SummaryModel } from "@shared/preferences";
```

Add to the `PrefsState` interface (after `pdfZoom: number;`):

```ts
/** AI 对话 agent 循环的多步上限；0 = 不限制。落盘记忆，重启恢复。 */
stepLimit: number;
```

Add to the `PrefsActions` interface (after `setPdfZoom`):

```ts
  setStepLimit: (v: number) => void;
```

Add to `PREFS_INITIAL` (after `pdfZoom: 1,`):

```ts
  stepLimit: DEFAULT_STEP_LIMIT,
```

Add the action in the store body (after the `setPdfZoom` action):

```ts
  setStepLimit: (stepLimit) => {
    persistPreference({ key: "stepLimit", value: stepLimit });
    set({ stepLimit });
  },
```

- [ ] **Step 4: Hydrate from the snapshot**

In `src/renderer/store/hydrate-preferences.ts`, add this line at the end of `hydratePreferences` (after the `pdfZoom` line). Use `!== undefined` (not truthy) so the falsy `0` (unlimited) hydrates correctly:

```ts
if (snap.stepLimit !== undefined) usePrefsStore.setState({ stepLimit: snap.stepLimit });
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts src/renderer/store/prefs-store.test.ts
git commit -m "feat(settings): add stepLimit to prefs store and hydration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Pure helper — `clampStepLimit`

**Files:**

- Modify: `src/renderer/settings/settings-logic.ts`
- Test: `src/renderer/settings/settings-logic.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/renderer/settings/settings-logic.test.ts`, add to the imports:

```ts
import { clampStepLimit } from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
```

(`clampStepLimit` can be merged into the existing destructured import from `settings-logic` instead of a second import line, if preferred.)

Add a new describe block at the end of the file:

```ts
describe("clampStepLimit", () => {
  it("clamps to [1,99], truncates floats, falls back on non-finite", () => {
    expect(clampStepLimit(5)).toBe(5);
    expect(clampStepLimit(0)).toBe(1); // 0 不经数字框——这里是防御性收敛
    expect(clampStepLimit(100)).toBe(99);
    expect(clampStepLimit(3.7)).toBe(3);
    expect(clampStepLimit(NaN)).toBe(DEFAULT_STEP_LIMIT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts`
Expected: FAIL — `clampStepLimit` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/renderer/settings/settings-logic.ts`, add the import at the top:

```ts
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
```

Add the function at the end of the file:

```ts
/** 数字输入框的 stepLimit 取值收敛到 [1, 99] 整数；非有限值（空输入/NaN）回退默认。
 *  注意：0（不限制）不经此函数——它由「不限制」复选框直接产生、不走数字框。 */
export function clampStepLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_STEP_LIMIT;
  return Math.min(99, Math.max(1, Math.trunc(raw)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings/settings-logic.ts src/renderer/settings/settings-logic.test.ts
git commit -m "feat(settings): add clampStepLimit helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: UI — stepLimit control in Advanced settings + i18n

**Files:**

- Modify: `src/renderer/settings/AdvancedSettings.tsx`
- Modify (via extract + manual en): `src/shared/i18n/locales/zh-CN.ts`, `src/shared/i18n/locales/en.ts`

- [ ] **Step 1: Replace AdvancedSettings.tsx with the stepLimit control added**

Full new contents of `src/renderer/settings/AdvancedSettings.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { clampStepLimit } from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const stepLimit = usePrefsStore((s) => s.stepLimit);
  const setStepLimit = usePrefsStore((s) => s.setStepLimit);
  const unlimited = stepLimit === 0;
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.advanced", "高级")}</h2>

      <div className="flex items-start justify-between gap-3">
        <label htmlFor="step-limit" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.advanced.stepLimit", "单次回复最多步数")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.advanced.stepLimitDesc",
              "AI 单次回复中连续调用工具的步数上限，阅读 PDF 逐页时需要调高。勾选「不限制」后仅靠模型自然停止与手动停止收尾——模型若陷入循环会持续消耗额度。",
            )}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-3">
          <Input
            id="step-limit"
            type="number"
            min={1}
            max={99}
            value={unlimited ? "" : stepLimit}
            disabled={unlimited}
            onChange={(e) => setStepLimit(clampStepLimit(e.target.valueAsNumber))}
            className="w-16"
          />
          <label
            htmlFor="step-limit-unlimited"
            className="flex cursor-pointer items-center gap-1.5"
          >
            <Checkbox
              id="step-limit-unlimited"
              checked={unlimited}
              onCheckedChange={(checked) => setStepLimit(checked ? 0 : DEFAULT_STEP_LIMIT)}
            />
            <span className="text-sm">{t("settings.advanced.stepLimitUnlimited", "不限制")}</span>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("settings.logs", "日志")}</span>
        <Button variant="outline" size="sm" onClick={() => void window.api.app.openLogsDir()}>
          <FolderOpen />
          {t("settings.openLogsFolder", "打开日志文件夹")}
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Extract i18n keys (sync primary language)**

Run: `pnpm i18n:extract`
Expected: `src/shared/i18n/locales/zh-CN.ts` gains the three new keys with the Chinese fallbacks; `en.ts` gains them with empty `""` values (primaryLanguage is zh-CN).

Note (known i18n gotcha): extract back-fills locales from source `t()` fallbacks. For brand-new keys this just creates them — it will not clobber existing en translations. Verify with:

Run: `rg -n 'settings.advanced.stepLimit' src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts`
Expected: all three keys (`stepLimit`, `stepLimitDesc`, `stepLimitUnlimited`) present in BOTH files.

- [ ] **Step 3: Fill in the English translations manually**

In `src/shared/i18n/locales/en.ts`, set the three new keys (extract left them `""`). Place them near the other `settings.advanced*` keys:

```ts
  "settings.advanced.stepLimit": "Max steps per reply",
  "settings.advanced.stepLimitDesc":
    "Cap on how many consecutive tool-call steps the AI takes in a single reply — raise it for page-by-page PDF reading. With \"Unlimited\", only the model stopping on its own or you stopping it ends the turn; a model stuck in a loop keeps spending tokens.",
  "settings.advanced.stepLimitUnlimited": "Unlimited",
```

(Exact key order doesn't matter; `sort: true` reorders on next extract. Match the surrounding quoting/indent style of the file.)

- [ ] **Step 4: Verify typecheck + i18n lint + the app builds clean**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm i18n:lint`
Expected: no missing-key errors for the new keys. (If lint under-reports, the Step 2 `rg` check is the source of truth.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings/AdvancedSettings.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(settings): add stepLimit control to advanced settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification + changeset

**Files:**

- Create: `.changeset/<two-word-slug>.md`

- [ ] **Step 1: Run the full suite green**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm test`
Expected: PASS (all files, including the new `stepLimit`/`clampStepLimit` tests).

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 2: Write the changeset (user-facing English changelog)**

Create `.changeset/configurable-step-limit.md` with:

```markdown
---
"marginalia": minor
---

Add a configurable step limit for AI replies (Advanced settings). The default agent step cap is raised from 5 to 10, and you can set any value from 1–99 or choose "Unlimited" — helpful for page-by-page PDF reading where the AI needs more tool-call steps to gather context.
```

- [ ] **Step 3: Commit the changeset**

```bash
git add .changeset/configurable-step-limit.md
git commit -m "chore: changeset for configurable stepLimit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Manual smoke (recommended, optional)**

Launch the dev app, open Settings → Advanced. Verify:

- The "Max steps per reply" number input shows `10` by default.
- Typing a value (e.g. `20`) persists and survives an app restart.
- Checking "Unlimited" disables/greys the number input; unchecking restores `10`.
- (Optional) With a PDF book, a multi-page reading question now reads past 5 steps.

---

## Notes for the implementer

- **falsy 0 is the recurring trap:** hydrate uses `!== undefined`; send-deps and send.ts use `??` (never `||`). The clamp helper never emits 0 (that path is the checkbox only).
- **`() => false` typing:** if `pnpm typecheck` complains about the `StopCondition` argument, import `type StopCondition` from `"ai"` and annotate, but a no-arg arrow is normally assignable to `(options) => boolean`.
- **Do not** add an upper `max` to the Zod schema — the cap is a UI-layer concern (`clampStepLimit`), and "unlimited" is `0`. The schema stays `z.number().int().min(0)`.
