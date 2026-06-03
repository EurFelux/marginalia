# 颜色模式（Color Mode）设计

> 状态：已确认（2026-06-03）。作用域：应用外壳 **＋** 阅读区书页一起随主题切换。
> 默认：`system`（跟随 OS 外观）。零启动闪白（同步 preload 读）。

## 1. 目标与非目标

**目标**

- 三档颜色模式 `light` / `dark` / `system`，可在「设置」面板切换、持久化到 `preferences` 表。
- `system` 档跟随操作系统外观，OS 切换时实时跟随。
- 主题同时作用于**应用外壳**（侧栏 / 设置 / 弹窗 / 书库 / AI 面板等 chrome）**和 epub 书页正文**（iframe 内）。
- **零启动闪白**：首帧 paint 前 `.dark` class 即就位（含手动选了与系统相反模式的用户）。

**非目标（记 backlog，不在本次）**

- 与外壳**解耦**的独立「阅读主题」（如 sepia / 纸黄 / 与 chrome 不同的夜间档）——本次书页主题与外壳**统一联动**，不单独控制。
- 覆盖 epub 内**带 `!important` 硬编码颜色**的书：注入点在 ePub 自带样式**之前**，此类书的硬编码色无法被夜间样式覆盖（见 §5 已知局限）。
- 图片反色 / 智能降亮：本次仅对图片做轻微 `brightness(0.9)`。
- `nativeTheme`（Electron 主进程主题源）联动：本次纯靠渲染层 class + `matchMedia`，不动 `nativeTheme.themeSource`。

## 2. 现状（已就位的基建）

- **CSS 层完全就绪**：`src/index.css` 有 `@custom-variant dark (&:is(.dark *))`（class 制暗色），`:root`（亮）与 `.dark`（暗）两套完整 token——shadcn token、landing 自定义 token（`--sea-ink` 等）、`color-scheme` 均已双份定义。**但 `.dark` class 目前从未被挂到任何元素**，故 app 现永远是亮色、暗 token 休眠。
- **偏好基建就绪**：`preferences` 表（key/value text）、`PREFERENCE_SCHEMAS` Zod 注册表、`hydratePreferences()`（启动灌入）、`persistPreference()`（变更落盘）。`colorMode` 键此前按计划留到本功能落地再注册。
- **书页样式注入点就绪**：`@marginalia/virtual-docs` 的 `VirtualDocs` 有 `styleCss` prop（EpubReader 现传 `prefsToCss(prefs) + ANNO_IFRAME_CSS`），`SectionFrame.buildSrcDoc` 把它注在 ePub 自带样式**之前**；`srcDoc = useMemo([html, styleCss])`，**改 `styleCss` 即重载 iframe 应用新样式**（与改字号同一条路）。

## 3. 数据与契约（`src/shared/`）

`src/shared/preferences.ts`：

```ts
/** 颜色模式三档。renderer 的 ColorMode 由此推导，单一源。 */
export const colorMode = z.enum(["light", "dark", "system"]);
export type ColorMode = z.infer<typeof colorMode>;
```

- 注册进 `PREFERENCE_SCHEMAS`：`colorMode: colorMode`。
- `setPreferenceInput` 判别联合加一条 arm：`z.object({ key: z.literal("colorMode"), value: colorMode })`。
- `preferences.test.ts` 同步：断言 `colorMode` 在 `PREFERENCE_SCHEMAS` 与 `setPreferenceInput` 中均存在且校验三档合法值、拒非法值。

**无 DB 迁移**：`preferences` 是 key/value 文本表，加键纯属应用层 Zod 增量，DB schema 不变。

## 4. 零闪白启动（preferences 通用同步通道）

颜色偏好存 DB（异步 IPC），最早 hydrate 后才知真实模式。为消除首帧闪白，需在 preload 阶段同步读取并在 paint 前挂 class。

**原则：preferences 只用一个通用读通道，不加 per-preference / colorMode 专属通道。** 把现有异步读通道 `preferences:get-all`（`ipcMain.handle` + invoke，仅 `hydratePreferences` 在用）**改造为同步全量快照通道**，复用现成的 `getAllPreferences(db)`，删掉异步版。改造后 preferences 仅剩**两个通道**：`preferences:get-all-sync`（读）+ `preferences:set`（写），零 per-preference 通道。读出的整份 `PreferencesSnapshot` 既驱动首帧挂 `.dark`，也供所有 store 同步初始化（连 `readerPrefs` 等也免异步那一跳）。

**`src/shared/ipc.ts`**：`preferencesGetAll: "preferences:get-all"` → 改名 `preferencesGetAllSync: "preferences:get-all-sync"`（语义=同步 sendSync，区别于 invoke）。

**主进程**（`src/main/ipc/preferences-handlers.ts`，glue 层，**故意绕开**异步 `registry.handle`，加注释）：

```ts
ipcMain.on(IPC.preferencesGetAllSync, (e) => {
  // 同步通道（sendSync）：getDb() 在 DB 未就绪时可能抛，整体兜底返回 {}，绝不让首帧读崩。
  try {
    e.returnValue = getAllPreferences(getDb());
  } catch {
    e.returnValue = {};
  }
});
```

- `getAllPreferences(db)` 复用现成实现（损坏 / 未知 key 已跳过，返回 `PreferencesSnapshot`），无需新增纯函数。
- 时序安全：DB 在 `app.ready` 的 `initDb()` 初始化，窗口（及其 preload）在 `whenReady` 后创建，故 preload 跑 `sendSync` 时 DB 已就绪；仍对「DB 未就绪」防御性返回 `{}`。

**preload**（`src/preload.ts`）：模块加载时同步读一次整份快照，应用主题，并把快照暴露给渲染层。

```ts
const prefsSnapshot = ipcRenderer.sendSync(IPC.preferencesGetAllSync) as PreferencesSnapshot;
applyBootstrapTheme(prefsSnapshot.colorMode ?? "system"); // 解析 + 立刻挂 .dark（system 经 matchMedia）
// window.api.preferences.getAll() 改为**同步**返回这份缓存快照（read 仅启动一次；set 仍异步 invoke）：
//   preferences: { getAll: () => prefsSnapshot, set: (input) => ipcRenderer.invoke(IPC.preferencesSet, input) }
```

- `applyBootstrapTheme(mode)`：`resolveTheme(mode, prefersDark())` → `document.documentElement.classList.toggle("dark", resolved === "dark")`。preload 运行在渲染进程、首帧前，且 DOM 跨上下文共享（contextIsolation 仅隔离 JS 全局、不挡 DOM），故 `document.documentElement` 可直接操作。若该元素此刻尚不可得（极早期），回退到 `src/renderer.tsx` 模块顶层（`createRoot` 之前）再 apply 一次。
- `prefersDark()`：`window.matchMedia?.("(prefers-color-scheme: dark)").matches === true`（preload 有 `window` / `matchMedia`）。
- `window.api.preferences.getAll` 的契约从 `Promise<PreferencesSnapshot>` 改为同步 `PreferencesSnapshot`（boot 时已取，读一次足矣；`set` 保持异步 fire-and-forget——这一读同步/写异步的非对称是有意的）。DB 仍是唯一数据源，**不引入 localStorage**。

## 5. 渲染层：主题状态与应用（`src/renderer/`）

### 5.1 纯函数（可测，无 DOM 依赖）

`src/renderer/theme/resolve-theme.ts`：

```ts
import type { ColorMode } from "@shared/preferences";
export type ResolvedTheme = "light" | "dark";

/** 把三档 colorMode + 系统是否暗 解析为实际生效的 light/dark。纯函数。 */
export function resolveTheme(mode: ColorMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
```

### 5.2 `theme-store.ts`（zustand，独立职责）

```ts
interface ThemeState {
  colorMode: ColorMode; // 用户选择（持久化）
  resolvedTheme: ResolvedTheme; // 实际生效（派生）
  setColorMode: (mode: ColorMode) => void; // persist + set + 重解析
  syncSystem: () => void; // OS 外观变化时按当前 colorMode 重解析
}
```

- `prefersDark()` 薄包（读 `matchMedia`，不可测，同其它 window guard）。
- 初值同步取自 `window.api?.preferences?.getAll?.()?.colorMode ?? "system"`（同步 getAll 缓存于 preload boot；headless 缺 window → `"system"`），`resolvedTheme = resolveTheme(initialMode, prefersDark())`。
- `setColorMode(mode)`：`persistPreference({ key: "colorMode", value: mode })` → `set({ colorMode: mode, resolvedTheme: resolveTheme(mode, prefersDark()) })`。
- `syncSystem()`：`set({ resolvedTheme: resolveTheme(get().colorMode, prefersDark()) })`。

### 5.3 `<ThemeController/>`（挂在 `App`，返回 `null`）

- effect①（依赖 `resolvedTheme`）：`document.documentElement.classList.toggle("dark", resolvedTheme === "dark")`。与 preload 应用一致；负责后续状态变更时同步 class。
- effect②（依赖 `colorMode`）：仅当 `colorMode === "system"` 时订阅 `matchMedia("(prefers-color-scheme: dark)")` 的 `change` → 调 `syncSystem()`；cleanup 解绑。
- React Compiler 已启用：**不写**手动 `useCallback`/`useMemo`；effect 的命令式订阅 / cleanup 保留。

### 5.4 hydratePreferences 改同步、不重复处理 colorMode

- `hydratePreferences()` 改为**同步**：读 `window.api.preferences.getAll()`（已是同步缓存快照，去掉 `await`），照旧 `setState` 灌 `readerPrefs` / `lastHighlightStyle` / `autoSummarize` 到各 store。仍在 `App` 挂载时调用一次。
- **不读 `snap.colorMode`**：colorMode 已由 theme-store 在模块初始化时从同一份快照同步取走（并经 preload 在首帧前挂好 class），避免二次翻转——加注释说明 colorMode 由 theme-store 接管。

## 6. 书页暗色（注入 iframe）

`src/renderer/reader/reader-theme-css.ts`（纯函数，可测）：

```ts
/** 暗色书页注入 CSS；亮色返回 "" 让 ePub 自带纸张样式生效。 */
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

- EpubReader 订阅 `useThemeStore((s) => s.resolvedTheme)`，拼接：

  ```ts
  styleCss={prefsToCss(prefs) + "\n" + ANNO_IFRAME_CSS + "\n" + readerThemeCss(resolvedTheme === "dark")}
  ```

- 改 `styleCss` 即令 `srcDoc` 重建、iframe 重载并应用新样式（与改字号同机制，零新机制）。`system` 档下 OS 切换 → `syncSystem` 更新 `resolvedTheme` → styleCss 变 → 书页随之翻。
- 颜色写死十六进制（iframe 取不到父文档 CSS 变量），取护眼柔和暗（非纯黑）；值可后续微调。
- **已知局限**：注入在 ePub 自带样式之前，故 `!important` 硬编码颜色的书无法被覆盖；图片仅轻微调暗不反色。v1 接受，记 backlog。

## 7. 切换 UI（SettingsPanel）

- `pnpx shadcn@latest add toggle-group -y` 拉 Base UI `ToggleGroup`/`Toggle`（`components.json` base-nova registry 映射 `@base-ui/react` 的 ToggleGroup）。装完 `postinstall` 自动 `db:rebuild:electron`（已就位），无需手动。
- 在 `SettingsPanel` 的 autoSummarize 行附近加「外观」一行，单选 `ToggleGroup`：
  - `light`（Sun 图标）/ `dark`（Moon）/ `system`（Monitor），lucide-react 已在用。
  - `value={colorMode}`、`onValueChange` → `setColorMode`（仅在非空值时写，避免取消选中态）。
- 样式走 Tailwind 工具类（项目 UI 规范），不内联 CSS。

## 8. 测试

- `src/shared/preferences.test.ts`：`colorMode` 进 `PREFERENCE_SCHEMAS` + `setPreferenceInput` arm；校验三档合法、拒非法。
- `src/main/preferences/repository.test.ts`：补 `colorMode` 经 `setPreference` / `getAllPreferences` 往返一致一例（同步通道复用此函数，读路径即被覆盖；损坏 / 未知 key 跳过的既有用例不变）。
- `resolveTheme(mode, prefersDark)`：6 组断言（light/dark 忽略 prefersDark；system×{true,false}）。
- `readerThemeCss(isDark)`：`false → ""`；`true →` 含 `background-color`/`color`/`!important`、含 `img` 降亮。
- **手动 GUI**：三档切换 → 外壳 + 书页**同步**翻；`system` 档跟随 OS 外观实时切换；重启 app → **零闪白** + 持久化保持；headless `pnpm test` 全绿。

## 9. 涉及文件清单

**新增**

- `src/renderer/theme/resolve-theme.ts`（+ test）
- `src/renderer/store/theme-store.ts`
- `src/renderer/theme/ThemeController.tsx`
- `src/renderer/reader/reader-theme-css.ts`（+ test）
- `src/renderer/components/ui/toggle-group.tsx` / `toggle.tsx`（shadcn 生成）

**修改**

- `src/shared/preferences.ts`（注册 colorMode + arm）、`preferences.test.ts`
- `src/shared/ipc.ts`（`preferencesGetAll` → `preferencesGetAllSync` 通道改名）
- `src/main/ipc/preferences-handlers.ts`（异步 `handle(getAll)` → 同步 `ipcMain.on(getAllSync)`，复用 `getAllPreferences`）
- `src/main/preferences/repository.test.ts`（补 colorMode 往返一例）
- `src/preload.ts`（`sendSync` 读全量快照 + `applyBootstrapTheme` + `getAll` 改同步返回缓存快照）
- `src/renderer/App.tsx`（挂 `<ThemeController/>`）
- `src/renderer/store/hydrate-preferences.ts`（改同步读 `getAll()`；注释：colorMode 由 theme-store 接管）
- `src/renderer/reader/EpubReader.tsx`（styleCss 拼 readerThemeCss）
- `src/renderer/settings/SettingsPanel.tsx`（ToggleGroup「外观」一行）
- `docs/superpowers/ROADMAP.md`（合并时标 ✅ + 记 backlog：书页硬编码色 / 独立阅读主题）
