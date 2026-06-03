# 颜色模式（Color Mode）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给应用加 `light`/`dark`/`system` 三档颜色模式，外壳 + epub 书页统一随主题切换，默认跟随系统、零启动闪白、持久化到 `preferences` 表。

**Architecture:** CSS 暗色 token 已就位（`.dark` class variant + `:root`/`.dark` 双套），本计划只负责「挂 `.dark` class + 注入书页暗色 CSS + 偏好状态/UI」。preferences 读取收口为**单一通用同步通道** `preferences:get-all-sync`（`sendSync`，复用 `getAllPreferences`，删异步 `get-all`）；preload 在首帧前同步读整份快照→挂 class，并供所有 store 同步初始化。书页暗色经 `VirtualDocs` 现成的 `styleCss` 注入 iframe（改 styleCss 即重载，零新机制）。

**Tech Stack:** Electron 41 + React 19 + Zustand + Zod 4 + Tailwind v4（class 制暗色）+ shadcn(Base UI) ToggleGroup + vitest（Electron 运行时）。

**前置约定（每个 commit 都遵守）：**

- 提交用 Conventional Commits；末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 提交用 `git commit --no-verify`（prek 的类型 lint 极慢）；提交前手动跑 `pnpm typecheck` + 相关 `pnpm test` 确保绿。
- 当前分支 `feat/color-mode`，spec 已提交，**不要切分支**。
- React Compiler 已启用：**不写**手动 `useCallback`/`useMemo`；effect 的命令式订阅 / cleanup 照常手写。
- 测试文件必须是 `.test.ts`（vitest `include` 不含 `.tsx`）。

---

## File Structure

**新建**

- `src/shared/theme.ts` — 纯函数 `resolveTheme(mode, prefersDark) → ResolvedTheme` + `ResolvedTheme` 类型（放 `@shared` 因 preload 也要用；preload 只能 import `@shared/*`）。
- `src/shared/theme.test.ts` — resolveTheme 单测。
- `src/renderer/store/theme-store.ts` — zustand：`colorMode` + 派生 `resolvedTheme` + `setColorMode` + `syncSystem`。
- `src/renderer/store/theme-store.test.ts` — store 行为单测（headless 无 window → system 解析为 light）。
- `src/renderer/theme/ThemeController.tsx` — 把 `resolvedTheme` 落到 `<html>.dark` + 订阅 OS 外观变化；返回 null。
- `src/renderer/reader/reader-theme-css.ts` — 纯函数 `readerThemeCss(isDark) → string`（书页暗色注入 CSS）。
- `src/renderer/reader/reader-theme-css.test.ts` — readerThemeCss 单测。
- `src/renderer/components/ui/toggle-group.tsx` + `toggle.tsx` — shadcn CLI 生成。

**修改**

- `src/shared/preferences.ts` — 注册 `colorMode` 枚举 + `PREFERENCE_SCHEMAS` + `setPreferenceInput` arm。
- `src/shared/preferences.test.ts` — 断言含 colorMode。
- `src/shared/ipc.ts` — `preferencesGetAll` → `preferencesGetAllSync`。
- `src/main/ipc/preferences-handlers.ts` — 异步 `handle(getAll)` → 同步 `ipcMain.on(getAllSync)`；`set` switch 补 `colorMode` arm。
- `src/main/preferences/repository.test.ts` — 补 colorMode 往返。
- `src/preload.ts` — `sendSync` 读快照 + `applyBootstrapTheme` + `getAll` 改同步返回缓存。
- `src/renderer/store/hydrate-preferences.ts` — 改同步读 `getAll()`。
- `src/renderer/App.tsx` — `hydratePreferences()` 去 `void` + 挂 `<ThemeController/>`。
- `src/renderer/reader/EpubReader.tsx` — `styleCss` 拼 `readerThemeCss`。
- `src/renderer/settings/SettingsPanel.tsx` — ToggleGroup「外观」一行。
- `docs/superpowers/ROADMAP.md` — 标 ✅ + backlog。

---

### Task 1: 注册 `colorMode` 偏好（shared 单一源 + 仓储覆盖）

**Files:**

- Modify: `src/shared/preferences.ts`
- Test: `src/shared/preferences.test.ts`
- Test: `src/main/preferences/repository.test.ts`

- [ ] **Step 1: 改测试到新预期（先红）**

`src/shared/preferences.test.ts` —— 改这三处 `it`：

```ts
it("registers exactly the keys with current consumers", () => {
  expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
    "autoSummarize",
    "colorMode",
    "lastHighlightStyle",
    "readerPrefs",
  ]);
});

it("preferenceKey accepts known keys and rejects unknown", () => {
  expect(preferenceKey.safeParse("readerPrefs").success).toBe(true);
  expect(preferenceKey.safeParse("colorMode").success).toBe(true);
  expect(preferenceKey.safeParse("nope").success).toBe(false);
});

it("setPreferenceInput validates value per key at the boundary", () => {
  expect(setPreferenceInput.safeParse({ key: "autoSummarize", value: true }).success).toBe(true);
  expect(setPreferenceInput.safeParse({ key: "autoSummarize", value: "yes" }).success).toBe(false);
  expect(setPreferenceInput.safeParse({ key: "colorMode", value: "dark" }).success).toBe(true);
  expect(setPreferenceInput.safeParse({ key: "colorMode", value: "sepia" }).success).toBe(false);
  expect(
    setPreferenceInput.safeParse({ key: "readerPrefs", value: { fontScale: 1 } }).success,
  ).toBe(false);
  expect(setPreferenceInput.safeParse({ key: "unknownKey", value: 1 }).success).toBe(false);
});
```

`src/main/preferences/repository.test.ts` —— 在 `describe("preferences repository", () => {` 块内新增一个 `it`（放在 `round-trips each known key` 之后）：

```ts
it("round-trips colorMode", () => {
  const db = freshDb();
  setPreference(db, "colorMode", "dark");
  expect(getPreference(db, "colorMode")).toBe("dark");
  expect(getAllPreferences(db)).toEqual({ colorMode: "dark" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/preferences.test.ts src/main/preferences/repository.test.ts`
Expected: FAIL（`colorMode` 未注册——keys 数组不含 colorMode、`preferenceKey` 拒 colorMode、`setPreference(db,"colorMode",…)` 类型/运行时报未知 key）。

- [ ] **Step 3: 在 `src/shared/preferences.ts` 注册 colorMode**

在 `readerPrefsSchema` 定义之后、`PREFERENCE_SCHEMAS` 之前插入：

```ts
/** 颜色模式三档。renderer 的 ColorMode 由此推导，单一源。 */
export const colorMode = z.enum(["light", "dark", "system"]);
export type ColorMode = z.infer<typeof colorMode>;
```

把 `PREFERENCE_SCHEMAS` 改为（同时删掉注释里「颜色模式等零消费方项暂不注册」那句）：

```ts
/**
 * 可持久化用户偏好的单一源：key → 值 Zod schema。
 * 新增偏好＝在此注册一个 key + schema；DB / 服务 / IPC / 类型全部据此推导。
 */
export const PREFERENCE_SCHEMAS = {
  readerPrefs: readerPrefsSchema,
  lastHighlightStyle: annotationStyle,
  autoSummarize: z.boolean(),
  colorMode,
} as const;
```

把 `setPreferenceInput` 补一条 arm：

```ts
export const setPreferenceInput = z.discriminatedUnion("key", [
  z.object({ key: z.literal("readerPrefs"), value: readerPrefsSchema }),
  z.object({ key: z.literal("lastHighlightStyle"), value: annotationStyle }),
  z.object({ key: z.literal("autoSummarize"), value: z.boolean() }),
  z.object({ key: z.literal("colorMode"), value: colorMode }),
]);
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm test src/shared/preferences.test.ts src/main/preferences/repository.test.ts`
Expected: PASS（全部）。
Run: `pnpm typecheck`
Expected: 0 errors。

> 注意：此时 `src/main/ipc/preferences-handlers.ts` 的 `set` switch 仍未含 `colorMode` 分支，但因函数返回 `void` 且无穷尽性约束，**不会 typecheck 报错**——latent 漏洞留待 Task 3 补齐（届时该文件整体重写）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts src/main/preferences/repository.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(preferences): register colorMode (light/dark/system) key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `resolveTheme` 纯函数（`@shared`，preload 与 renderer 共用）

**Files:**

- Create: `src/shared/theme.ts`
- Test: `src/shared/theme.test.ts`

- [ ] **Step 1: 写失败测试**

`src/shared/theme.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveTheme } from "@shared/theme";

describe("resolveTheme", () => {
  it("returns the explicit mode for light/dark regardless of system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system preference when mode is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/theme.test.ts`
Expected: FAIL（`Cannot find module '@shared/theme'` 或 `resolveTheme is not a function`）。

- [ ] **Step 3: 实现 `src/shared/theme.ts`**

```ts
import type { ColorMode } from "@shared/preferences";

/** 主题解析后的实际生效值（已消解 system）。 */
export type ResolvedTheme = "light" | "dark";

/** 把三档 colorMode + 系统是否偏好暗 解析为实际生效的 light/dark。纯函数（无 DOM 依赖）。 */
export function resolveTheme(mode: ColorMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm test src/shared/theme.test.ts`
Expected: PASS（2 个）。
Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
git add src/shared/theme.ts src/shared/theme.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(theme): add resolveTheme pure helper (shared)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: preferences 读取收口为单一同步通道 + 同步 hydrate + 首帧挂 `.dark`

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/preferences-handlers.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`
- Modify: `src/renderer/App.tsx`（仅去掉 hydrate 调用的 `void`；`<ThemeController/>` 留到 Task 5）

> 本任务改动 IPC/preload 接线，无法单元测试。验收 = `pnpm typecheck` + 既有 `pnpm test` 全绿 + lint。真实运行表现在 Task 9 的 GUI smoke 验证。

- [ ] **Step 1: `src/shared/ipc.ts` 改通道名**

把 `IPC` 对象里这行：

```ts
  preferencesGetAll: "preferences:get-all",
```

改为：

```ts
  preferencesGetAllSync: "preferences:get-all-sync",
```

- [ ] **Step 2: 重写 `src/main/ipc/preferences-handlers.ts`**

整文件替换为（异步 `handle(getAll)` → 同步 `ipcMain.on`；`set` switch 补 `colorMode`；删去不再用的 `z` / `PreferencesSnapshot` import）：

```ts
import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import { setPreferenceInput, type SetPreferenceInput } from "@shared/preferences";
import { getDb } from "@main/db/instance";
import { getAllPreferences, setPreference } from "@main/preferences/repository";
import { handle } from "@main/ipc/registry";

export function registerPreferenceHandlers(): void {
  // 读：同步 sendSync 通道——preload 在首帧前取整份快照（挂 .dark + hydrate）。
  // 故意绕开异步 registry.handle；getDb() 在 DB 未就绪时可能抛，整体兜底返回 {}，绝不让首帧读崩。
  ipcMain.on(IPC.preferencesGetAllSync, (e) => {
    try {
      e.returnValue = getAllPreferences(getDb());
    } catch {
      e.returnValue = {};
    }
  });

  // 写：运行时变更落盘（异步 invoke，fire-and-forget）。
  handle<SetPreferenceInput, void>(IPC.preferencesSet, setPreferenceInput, (input) => {
    // 按 key 判别窄化，使 (key, value) 关联类型传给泛型 setPreference 时成立（input 已经 Zod 校验）。
    switch (input.key) {
      case "readerPrefs":
        return setPreference(getDb(), input.key, input.value);
      case "lastHighlightStyle":
        return setPreference(getDb(), input.key, input.value);
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
      case "colorMode":
        return setPreference(getDb(), input.key, input.value);
    }
  });
}
```

- [ ] **Step 3: 改 `src/preload.ts`**

(a) 顶部 import：把 preferences 那行加上 `ColorMode`，并新增 theme import。改：

```ts
import type { PreferencesSnapshot, SetPreferenceInput } from "@shared/preferences";
```

为：

```ts
import type { ColorMode, PreferencesSnapshot, SetPreferenceInput } from "@shared/preferences";
import { resolveTheme } from "@shared/theme";
```

(b) 在 `const api = {` 之前插入引导逻辑：

```ts
/** 首帧前按持久化的颜色模式挂 .dark（system 经 matchMedia 解析）。 */
function applyBootstrapTheme(mode: ColorMode): void {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  document.documentElement.classList.toggle("dark", resolveTheme(mode, prefersDark) === "dark");
}

// 首帧前同步读整份偏好快照（read 仅启动一次）：驱动主题 + 供渲染层同步 hydrate。
const prefsSnapshot = ipcRenderer.sendSync(IPC.preferencesGetAllSync) as PreferencesSnapshot;
applyBootstrapTheme(prefsSnapshot.colorMode ?? "system");
```

(c) 把 `preferences.getAll` 从异步 invoke 改为同步返回缓存快照。改：

```ts
  preferences: {
    getAll: (): Promise<PreferencesSnapshot> => ipcRenderer.invoke(IPC.preferencesGetAll),
    set: (input: SetPreferenceInput): Promise<void> =>
      ipcRenderer.invoke(IPC.preferencesSet, input),
  },
```

为：

```ts
  preferences: {
    // 读同步（boot 时已取一次缓存于 prefsSnapshot）；写仍异步 fire-and-forget——非对称是有意的。
    getAll: (): PreferencesSnapshot => prefsSnapshot,
    set: (input: SetPreferenceInput): Promise<void> =>
      ipcRenderer.invoke(IPC.preferencesSet, input),
  },
```

- [ ] **Step 4: 改 `src/renderer/store/hydrate-preferences.ts` 为同步**

整文件替换为：

```ts
import { useReaderStore } from "@renderer/store/reader-store";
import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * 启动时从主进程同步快照 hydrate 各 store（缺失/损坏的 key 保持 store 默认值）。
 * 快照由 preload 在首帧前经 sendSync 取好缓存（window.api.preferences.getAll() 同步返回）。
 * 用 setState 直写（非 action）以免触发各 action 的回写持久化。在 App 挂载时调用一次。
 * 注：colorMode 不在此处处理——已由 theme-store 在初始化时从同一份快照同步接管（preload 已挂好 .dark）。
 */
export function hydratePreferences(): void {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  const snap = window.api.preferences.getAll();
  if (snap.readerPrefs) useReaderStore.setState({ prefs: snap.readerPrefs });
  if (snap.lastHighlightStyle) {
    useReaderStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
  }
  if (snap.autoSummarize !== undefined) {
    usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
  }
}
```

- [ ] **Step 5: 改 `src/renderer/App.tsx` 的 hydrate 调用**

`hydratePreferences` 现在同步返回 `void`，去掉 `void` 操作符。改：

```tsx
useEffect(() => {
  void hydratePreferences();
}, []);
```

为：

```tsx
useEffect(() => {
  hydratePreferences();
}, []);
```

- [ ] **Step 6: 类型检查 + 全量测试 + lint**

Run: `pnpm typecheck`
Expected: 0 errors（注意：若有别处引用 `IPC.preferencesGetAll` 会在此暴露——全局搜索确认仅 preload/handlers 用过）。
Run: `pnpm test`
Expected: 全绿（既有 215+ 用例不回归；hydrate 无单测，reader-store 测试不受影响）。
Run: `pnpm lint`
Expected: 0 errors（确认 preferences-handlers 删掉的 `z` import 未残留）。

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/preferences-handlers.ts src/preload.ts src/renderer/store/hydrate-preferences.ts src/renderer/App.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(preferences): single sync get-all-sync channel + boot theme apply

收口 preferences 读取为同步全量快照通道（复用 getAllPreferences，删异步
get-all）；preload 首帧前 sendSync 读快照并按 colorMode 挂 .dark，所有 store
同步 hydrate。set 处理补 colorMode 分支。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `theme-store`（colorMode + 派生 resolvedTheme）

**Files:**

- Create: `src/renderer/store/theme-store.ts`
- Test: `src/renderer/store/theme-store.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/store/theme-store.test.ts`（headless 无 window → `prefersDark()` 返回 false，`persistPreference` 自身 guard 为 no-op）：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useThemeStore } from "@renderer/store/theme-store";

beforeEach(() => useThemeStore.setState({ colorMode: "system", resolvedTheme: "light" }));

describe("theme-store", () => {
  it("setColorMode('dark') sets colorMode and resolves dark", () => {
    useThemeStore.getState().setColorMode("dark");
    expect(useThemeStore.getState().colorMode).toBe("dark");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  it("setColorMode('light') resolves light", () => {
    useThemeStore.getState().setColorMode("light");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("setColorMode('system') resolves via system (no window → light)", () => {
    useThemeStore.getState().setColorMode("system");
    expect(useThemeStore.getState().colorMode).toBe("system");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("syncSystem re-resolves from current colorMode", () => {
    useThemeStore.setState({ colorMode: "dark", resolvedTheme: "light" });
    useThemeStore.getState().syncSystem();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/theme-store.test.ts`
Expected: FAIL（`Cannot find module '@renderer/store/theme-store'`）。

- [ ] **Step 3: 实现 `src/renderer/store/theme-store.ts`**

```ts
import { create } from "zustand";
import type { ColorMode } from "@shared/preferences";
import { resolveTheme, type ResolvedTheme } from "@shared/theme";
import { persistPreference } from "@renderer/store/persist-preference";

/** 读系统是否偏好暗色（matchMedia 薄包；headless 无 window → false）。 */
function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

/** 启动初值：preload 已把整份快照同步缓存于 window.api.preferences.getAll()。 */
function initialColorMode(): ColorMode {
  if (typeof window === "undefined") return "system";
  return window.api?.preferences?.getAll?.()?.colorMode ?? "system";
}

interface ThemeState {
  /** 用户选择（持久化）。 */
  colorMode: ColorMode;
  /** 实际生效（派生：system 经 matchMedia 消解）。 */
  resolvedTheme: ResolvedTheme;
  setColorMode: (mode: ColorMode) => void;
  /** OS 外观变化时按当前 colorMode 重解析（仅 system 档有意义）。 */
  syncSystem: () => void;
}

const initMode = initialColorMode();

export const useThemeStore = create<ThemeState>()((set, get) => ({
  colorMode: initMode,
  resolvedTheme: resolveTheme(initMode, prefersDark()),
  setColorMode: (colorMode) => {
    persistPreference({ key: "colorMode", value: colorMode });
    set({ colorMode, resolvedTheme: resolveTheme(colorMode, prefersDark()) });
  },
  syncSystem: () => set({ resolvedTheme: resolveTheme(get().colorMode, prefersDark()) }),
}));
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm test src/renderer/store/theme-store.test.ts`
Expected: PASS（4 个）。
Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/theme-store.ts src/renderer/store/theme-store.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(theme): add theme-store (colorMode + derived resolvedTheme)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `ThemeController` —— 落 `.dark` class + 订阅 OS 外观

**Files:**

- Create: `src/renderer/theme/ThemeController.tsx`
- Modify: `src/renderer/App.tsx`

> 纯 DOM 副作用，无单测；验收 = typecheck + lint，行为在 Task 9 GUI smoke 验。

- [ ] **Step 1: 实现 `src/renderer/theme/ThemeController.tsx`**

```tsx
import { useEffect } from "react";
import { useThemeStore } from "@renderer/store/theme-store";

/**
 * 把 resolvedTheme 落到 <html> 的 .dark class（与 preload 首帧应用一致，负责后续状态变更同步）；
 * colorMode==="system" 时订阅 OS 外观变化，实时重解析。返回 null（无 UI）。
 */
export function ThemeController() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const colorMode = useThemeStore((s) => s.colorMode);
  const syncSystem = useThemeStore((s) => s.syncSystem);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  useEffect(() => {
    if (colorMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncSystem();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [colorMode, syncSystem]);

  return null;
}
```

- [ ] **Step 2: 在 `src/renderer/App.tsx` 挂载**

加 import（与其它 import 同区）：

```tsx
import { ThemeController } from "@renderer/theme/ThemeController";
```

把 `return (` 的 JSX 改为在 `TooltipProvider` 内首位渲染 `<ThemeController />`：

```tsx
return (
  <TooltipProvider>
    <ThemeController />
    {view === "reader" ? <ReaderView /> : <LibraryView />}
    <SettingsPanel />
  </TooltipProvider>
);
```

- [ ] **Step 3: 类型检查 + lint**

Run: `pnpm typecheck`
Expected: 0 errors。
Run: `pnpm lint`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/theme/ThemeController.tsx src/renderer/App.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(theme): apply .dark class + follow OS appearance via ThemeController

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `readerThemeCss` 纯函数（书页暗色注入 CSS）

**Files:**

- Create: `src/renderer/reader/reader-theme-css.ts`
- Test: `src/renderer/reader/reader-theme-css.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/reader/reader-theme-css.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { readerThemeCss } from "@renderer/reader/reader-theme-css";

describe("readerThemeCss", () => {
  it("returns empty string for light (keep ePub paper styling)", () => {
    expect(readerThemeCss(false)).toBe("");
  });

  it("returns dark overrides for dark", () => {
    const css = readerThemeCss(true);
    expect(css).toContain("background-color: #15181c");
    expect(css).toContain("color: #c9cdd1");
    expect(css).toContain("!important");
    expect(css).toContain("img { filter: brightness(0.9); }");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/reader-theme-css.test.ts`
Expected: FAIL（`Cannot find module '@renderer/reader/reader-theme-css'`）。

- [ ] **Step 3: 实现 `src/renderer/reader/reader-theme-css.ts`**

```ts
/**
 * 暗色书页注入 iframe 的 CSS（由 VirtualDocs 拼在 ePub 自带样式**之前**）；
 * 亮色返回 "" 保留 ePub 原纸张样式。颜色写死十六进制（iframe 取不到父文档 CSS 变量），
 * 取护眼柔和暗（非纯黑）；`:where(...)` 0 特异性 + !important 救回带显式深色的正文元素。
 * 已知局限：带 `!important` 硬编码颜色的书无法被覆盖（注入在其样式之前）。
 */
export function readerThemeCss(isDark: boolean): string {
  if (!isDark) return "";
  return [
    `html { background-color: #15181c !important; }`,
    `body { background-color: #15181c !important; color: #c9cdd1 !important; }`,
    `body :where(p,li,dd,dt,blockquote,span,div,h1,h2,h3,h4,h5,h6,td,th,figcaption) { color: inherit !important; }`,
    `a { color: #6cb6d9 !important; }`,
    `img { filter: brightness(0.9); }`,
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/reader-theme-css.test.ts`
Expected: PASS（2 个）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/reader-theme-css.ts src/renderer/reader/reader-theme-css.test.ts
git commit --no-verify -m "$(cat <<'EOF'
feat(reader): add readerThemeCss for dark book-page injection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: EpubReader 接入书页暗色

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

> 行为在 Task 9 GUI smoke 验；本任务验收 = typecheck。

- [ ] **Step 1: 加 import**

在现有 reader import 区（`prefs-to-css` / `highlight` 附近）加：

```tsx
import { readerThemeCss } from "./reader-theme-css";
import { useThemeStore } from "../store/theme-store";
```

- [ ] **Step 2: 订阅 resolvedTheme**

在组件内其它 `useReaderStore(...)` 选择器旁加：

```tsx
const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
```

- [ ] **Step 3: styleCss 拼接书页暗色**

把 `<VirtualDocs>` 的 styleCss 这行：

```tsx
        styleCss={prefsToCss(prefs) + "\n" + ANNO_IFRAME_CSS}
```

改为：

```tsx
        styleCss={
          prefsToCss(prefs) + "\n" + ANNO_IFRAME_CSS + "\n" + readerThemeCss(resolvedTheme === "dark")
        }
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `pnpm typecheck`
Expected: 0 errors。
Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/EpubReader.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(reader): inject dark book-page CSS following resolved theme

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 切换 UI —— shadcn ToggleGroup「外观」一行

**Files:**

- Create: `src/renderer/components/ui/toggle-group.tsx`、`toggle.tsx`（CLI 生成）
- Modify: `src/renderer/settings/SettingsPanel.tsx`

> CLI 生成的组件内容无法预先写死，故本任务含「跑 CLI → 读生成文件确认 API → 据实接线」三步。

- [ ] **Step 1: 用 shadcn CLI 加 toggle-group**

Run: `pnpx shadcn@latest add toggle-group -y`
Expected: 生成 `src/renderer/components/ui/toggle-group.tsx` 与 `toggle.tsx`。`postinstall` 会自动 `db:rebuild:electron`（若 CLI 触发了依赖安装）。

> 若 base-nova registry 无 `toggle-group`：改用 `pnpx shadcn@latest add toggle -y` 后，按 `tabs.tsx` 的同构写法手搓一个基于 `@base-ui/react` `ToggleGroup` 的薄封装（`Toggle.Group` + `Toggle`），导出 `ToggleGroup` / `ToggleGroupItem`。

- [ ] **Step 2: 读生成文件、确认 ABI 与导出 API**

Run: `pnpm test src/main/app-service.test.ts`
Expected: PASS（确认 better-sqlite3 仍在 Electron ABI 145；如失败则 `pnpm db:rebuild:electron`）。
Run: `cat src/renderer/components/ui/toggle-group.tsx`
Expected: 确认导出名（`ToggleGroup` / `ToggleGroupItem`）与单选 API。**记下**：单选是用 `type="single"` 还是 Base UI 的 `value:string[]`/`toggleMultiple` 风格——Step 3 按实际签名接线。Base UI Tabs 曾有 `data-orientation` 与 shadcn 类名不匹配的坑，若 toggle-group 也有类似方向/激活态类名失效，按 `Sidebar.tsx` 既有兜底（显式 flex/激活类）处理。

- [ ] **Step 3: 在 `SettingsPanel.tsx` 加「外观」一行**

加 import：

```tsx
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { useThemeStore } from "@renderer/store/theme-store";
import type { ColorMode } from "@shared/preferences";
```

> 注：现有 `import { Check, X } from "lucide-react";` 合并为 `import { Check, Monitor, Moon, Sun, X } from "lucide-react";`。

在组件内取 store：

```tsx
const colorMode = useThemeStore((s) => s.colorMode);
const setColorMode = useThemeStore((s) => s.setColorMode);
```

在 autoSummarize 那一行（`border-t border-border pt-3` 的 div）**之前**插入「外观」行（若 Step 2 确认是 `type="single"` 风格）：

```tsx
<div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-3">
  <span className="text-sm font-medium">外观</span>
  <ToggleGroup
    type="single"
    value={colorMode}
    onValueChange={(v) => {
      if (v) setColorMode(v as ColorMode);
    }}
  >
    <ToggleGroupItem value="light" aria-label="亮色">
      <Sun className="size-4" />
    </ToggleGroupItem>
    <ToggleGroupItem value="dark" aria-label="暗色">
      <Moon className="size-4" />
    </ToggleGroupItem>
    <ToggleGroupItem value="system" aria-label="跟随系统">
      <Monitor className="size-4" />
    </ToggleGroupItem>
  </ToggleGroup>
</div>
```

> 若 Step 2 确认是 Base UI 数组风格（`value: string[]` + `toggleMultiple` 默认多选），改为单值适配：`value={[colorMode]}`、`onValueChange={(groupValue) => { const v = groupValue[0]; if (v) setColorMode(v as ColorMode); }}`，并给 `ToggleGroup` 传单选所需 prop（如 `toggleMultiple={false}` 或等价项，以 cat 出的实际签名为准）。空值不写（避免取消选中态丢档）。

- [ ] **Step 4: 类型检查 + lint + 全量测试**

Run: `pnpm typecheck`
Expected: 0 errors。
Run: `pnpm lint`
Expected: 0 errors。
Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ui/toggle-group.tsx src/renderer/components/ui/toggle.tsx src/renderer/settings/SettingsPanel.tsx package.json pnpm-lock.yaml
git commit --no-verify -m "$(cat <<'EOF'
feat(settings): color mode toggle (light/dark/system) via ToggleGroup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 集成验证 + ROADMAP

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 全量自动化验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿（typecheck 0、lint 0、所有测试通过，含 epub-parser 子包若跑 `pnpm test:all`）。

- [ ] **Step 2: 手动 GUI smoke（人工）**

Run: `pnpm start`（阻塞；人工验完关掉）
逐项确认：

1. 设置面板「外观」三档可点。
2. 切 `dark` → 外壳（侧栏/设置/弹窗）变暗 **且** 打开的书页正文也变暗；切 `light` → 都变回亮。
3. 切 `system`，改 OS 外观（系统设置→外观 亮/暗）→ 应用与书页实时跟随。
4. 选一档非系统态（如 dark），完全退出再 `pnpm start` → **无启动闪白**、保持上次选择。

- [ ] **Step 3: 更新 `docs/superpowers/ROADMAP.md`**

- 把 backlog 表里「**颜色模式**（dark / light / system 三档，跟随系统）」那行状态从 `🔴` 改为 `✅`。
- 在 backlog 增两行（沿用既有表格列格式）：
  - `书页暗色无法覆盖带 !important 硬编码颜色的 ePub`（🔴，颜色模式 v1 已知局限）。
  - `独立阅读主题（sepia / 与外壳解耦的夜间档）`（🔴，颜色模式后续）。
- 若 ROADMAP 顶部有「当前焦点 / 下一目标候选」散文提到颜色模式，更新为已完成。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit --no-verify -m "$(cat <<'EOF'
docs(roadmap): mark color mode done + record reader-theming backlog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: 收尾**

实现完成后用 superpowers:finishing-a-development-branch 收束 `feat/color-mode`（合并回 main / 建 PR / 保留，按届时选择）。

---

## 自审记录（spec 覆盖核对）

- §1 目标（三档/默认 system/跟随 OS/外壳+书页/零闪白）→ Task 1(键)、3(同步读+挂class)、4/5(状态+应用)、6/7(书页)、8(UI)、9(GUI 验)。✓
- §1 非目标（解耦阅读主题、硬编码色覆盖、图片反色、nativeTheme）→ 不实现，Task 9 记 backlog。✓
- §3 数据契约（colorMode 枚举 + 注册 + arm + 无迁移）→ Task 1。✓
- §4 单一同步通道（get-all-sync 复用 getAllPreferences，删异步、首帧挂 class、不引 localStorage）→ Task 3。✓ 含 set switch 的 colorMode arm（防静默 no-op）。
- §5 resolveTheme/theme-store/ThemeController/hydrate 同步 → Task 2/4/5 + Task 3(hydrate)。✓（resolveTheme 落 `@shared` 而非 spec 写的 `@renderer`——因 preload 边界只能 import `@shared`；已在 File Structure 标注。）
- §6 readerThemeCss + EpubReader styleCss → Task 6/7。✓
- §7 shadcn ToggleGroup「外观」行 → Task 8。✓
- §8 测试（preferences 注册/repo 往返/resolveTheme/readerThemeCss）→ Task 1/2/6 + Task 4 额外 store 测试。✓
- 类型一致性：`ColorMode`(@shared/preferences)、`ResolvedTheme`(@shared/theme)、`resolveTheme(mode,prefersDark)`、`readerThemeCss(isDark)`、`useThemeStore` 选择器签名跨任务一致。✓
