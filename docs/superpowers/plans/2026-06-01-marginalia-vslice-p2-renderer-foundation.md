# 竖切 Plan 2 · 渲染层地基 RA0（S1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 Forge 模板桩替换为真实 React 渲染层地基——依赖栈、Vite/别名配置、Tailwind4+本地字体、QueryClient、zustand stores、最小三栏壳消费 `window.api`，`pnpm start` 能看到挂载成功的空壳。

**Architecture:** 纯 React 19 + Vite（Electron renderer，无 router/SSR）。状态分层落地：TanStack Query（持久态）/ zustand（UI 态）/ useChat（流式，Plan 4）。`window.api`（Plan 1 已闭合）是唯一数据入口。

**Tech Stack:** React 19、Vite 8（`@vitejs/plugin-react` + `@tailwindcss/vite` + react-compiler via `@rolldown/plugin-babel`）、Tailwind 4、`@tanstack/react-query`、zustand、`@fontsource-variable`。

**上游:** spec `docs/superpowers/specs/2026-06-01-marginalia-vertical-slice-design.md` §6（RA0）；前置 Plan 1（preload `window.api` 已就绪）。

---

## 验收边界（务实声明）

- vitest 是 **node 环境无 jsdom**：本 plan 只对**纯逻辑**（query keys 工厂、zustand store actions、`cn`）写 `.test.ts` headless 测；React 组件/挂载靠 `pnpm typecheck` + **用户 `pnpm start` 手测**。
- implementer **不要**运行 `pnpm start`（阻塞式 GUI + 把 better-sqlite3 重编为 Electron ABI 破坏测试）。每个 Task 用 `pnpm typecheck`/`pnpm lint`/`pnpm test` 把关。
- 运行时（渲染是否真起来、字体/Tailwind 是否生效、react-compiler 是否兼容）由用户在 Plan 2 完成后 `pnpm start` 手测，手测后需 `pnpm db:rebuild:node` 才能再跑测试。

## 关键现状（勘察确认）

- `src/renderer.ts`：纯桩（`import "./index.css"` + console.log）。`index.html`：Forge 模板，`<script type="module" src="/src/renderer.ts">`，无 `<div id="root">`。
- `vite.renderer.config.ts`：仅 `@shared` alias，无 plugins。`forge.config.ts` renderer 配置 `{ name:"main_window", config:"vite.renderer.config.ts" }`。
- 别名四处：`@shared` 全有；`@main` 在 tsconfig/vite.main/vitest；**`@renderer` 处处无**。
- `vitest.config.ts`：`environment:"node"`、`globals:true`、`include:["src/**/*.test.ts"]`。
- 原型 `packages/ui-prototype/src/styles.css`（372 行）：`@import "tailwindcss"` + `@plugin "@tailwindcss/typography"` + `@custom-variant dark` + `@theme inline { oklch 色彩体系 + --font-sans/--font-serif }`，字体走 Google Fonts CDN（第 1 行 `@import url(...)`）。
- 原型 react-compiler：`@vitejs/plugin-react` 的 `reactCompilerPreset()` 经 `@rolldown/plugin-babel` 注入。
- 原型 `lib/utils.ts`：`cn = (...) => twMerge(clsx(...))`。
- preload 已导出 `RendererApi = typeof api`（`src/preload.ts`），含 `window.api.library.list()` 等。

## File Structure

| 文件                                                             | 动作     | 职责                                                   |
| ---------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| `package.json`                                                   | 改       | 新增前端依赖（见 Task 1）                              |
| `pnpm-workspace.yaml`                                            | 改(按需) | 若 `@tailwindcss/oxide` 等需构建，加入 `allowBuilds`   |
| `tsconfig.json` / `vite.renderer.config.ts` / `vitest.config.ts` | 改       | 加 `@renderer` 别名                                    |
| `vite.renderer.config.ts`                                        | 改       | 加 react / tailwind / react-compiler 插件              |
| `index.html`                                                     | 改       | `<div id="root">` + script 指向 `renderer.tsx` + title |
| `src/renderer.ts` → `src/renderer.tsx`                           | 改名+改  | React 挂载入口                                         |
| `src/index.css`                                                  | 改       | Tailwind4 + `@theme`（移植原型）+ 本地字体             |
| `src/renderer/global.d.ts`                                       | 建       | `Window.api: RendererApi` 全局声明                     |
| `src/renderer/lib/utils.ts`                                      | 建       | `cn`                                                   |
| `src/renderer/query/client.ts`                                   | 建       | QueryClient（适配本地 IPC 默认项）                     |
| `src/renderer/query/keys.ts`                                     | 建       | 查询键工厂 `qk`                                        |
| `src/renderer/query/keys.test.ts`                                | 建       | keys 工厂测试                                          |
| `src/renderer/lib/utils.test.ts`                                 | 建       | `cn` 测试                                              |
| `src/renderer/types.ts`                                          | 建       | renderer UI 本地类型（`SelectionInfo`）                |
| `src/renderer/store/reader-store.ts`                             | 建       | zustand reader store                                   |
| `src/renderer/store/reader-store.test.ts`                        | 建       | store actions 测试                                     |
| `src/renderer/store/settings-store.ts`                           | 建       | zustand settings UI store                              |
| `src/renderer/App.tsx`                                           | 建       | 最小两栏壳，`useQuery(library.list)`                   |

---

## Task 1：装依赖 + `@renderer` 别名

**Files:** `package.json`、`tsconfig.json`、`vite.renderer.config.ts`、`vitest.config.ts`、（按需）`pnpm-workspace.yaml`

- [ ] **Step 1：在根装运行时依赖**（与原型版本对齐，避免不兼容）

Run:

```bash
pnpm add @tanstack/react-query zustand lucide-react clsx tailwind-merge class-variance-authority @fontsource-variable/manrope @fontsource-variable/fraunces
```

- [ ] **Step 2：装开发依赖**

Run:

```bash
pnpm add -D @vitejs/plugin-react @tailwindcss/vite tailwindcss babel-plugin-react-compiler @rolldown/plugin-babel @tailwindcss/typography
```

> 若安装因原生包构建脚本被 pnpm 拦（如 `@tailwindcss/oxide`），把对应包名加进 `pnpm-workspace.yaml` 的 `allowBuilds:`（值 `true`）再 `pnpm install`。**不要**运行 `pnpm start`。装完跑一次 `pnpm test` 确认 better-sqlite3 仍是 Node ABI（应全绿；若报 ABI 不匹配则 `pnpm db:rebuild:node`）。

- [ ] **Step 3：`tsconfig.json` paths 加 `@renderer`**

```json
"paths": {
  "@shared/*": ["./src/shared/*"],
  "@main/*": ["./src/main/*"],
  "@renderer/*": ["./src/renderer/*"]
}
```

- [ ] **Step 4：`vitest.config.ts` alias 加 `@renderer`**

在 `resolve.alias` 数组追加：

```ts
{ find: "@renderer", replacement: path.resolve(__dirname, "src/renderer") },
```

- [ ] **Step 5：跑 typecheck + test 确认未破坏**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 仅剩预存 `forge.config.ts` 错误（注：`pnpm typecheck` 因该错 exit 非 0 属正常，确认无新错即可）；test 全绿。

- [ ] **Step 6：提交**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts
git commit -m "build(renderer): add frontend deps and @renderer path alias"
```

---

## Task 2：`vite.renderer.config.ts` 接入 React / Tailwind / react-compiler

**Files:** `vite.renderer.config.ts`

- [ ] **Step 1：改写 `vite.renderer.config.ts`**

```ts
import { defineConfig } from "vite";
import path from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@renderer", replacement: path.resolve(__dirname, "src/renderer") },
    ],
  },
});
```

> react-compiler 经 `@rolldown/plugin-babel` + `reactCompilerPreset()`，与原型一致。**降级备案**：若用户 `pnpm start` 时该 babel 插件在 Forge vite 8 下报错，移除 `babel({...})` 那一行即可（react-compiler 是优化、非功能必需），其余地基不受影响。

- [ ] **Step 2：typecheck**

Run: `pnpm typecheck`
Expected: 无新错（配置文件类型正确）。

- [ ] **Step 3：提交**

```bash
git add vite.renderer.config.ts
git commit -m "build(renderer): wire react/tailwind/react-compiler vite plugins"
```

---

## Task 3：HTML 入口 + 全局样式 + window 类型

**Files:** `index.html`、`src/index.css`、`src/renderer/global.d.ts`

- [ ] **Step 1：改写 `index.html`**

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Marginalia</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2：改写 `src/index.css`**——从原型 `packages/ui-prototype/src/styles.css` **移植**全局样式，做两处替换：

1. **删除**第 1 行的 Google Fonts `@import url("https://fonts.googleapis.com/...")`（字体改本地，见 Task 6 在 `renderer.tsx` 里 import `@fontsource-variable`）。
2. 保留 `@import "tailwindcss"`、`@plugin "@tailwindcss/typography"`、`@custom-variant dark (&:is(.dark *))`、整个 `@theme inline { ... }`（oklch 色彩体系 + radius）以及 base 层样式。
3. `@theme` 里字体变量改用 `@fontsource-variable` 的 family 名（**核对**装好的包 CSS 里的 `font-family`，通常是 `"Manrope Variable"` / `"Fraunces Variable"`）：

```css
--font-sans: "Manrope Variable", ui-sans-serif, system-ui, sans-serif;
--font-serif: "Fraunces Variable", Georgia, "Songti SC", serif;
```

4. 若原型用了 `tw-animate-css`（`@import "tw-animate-css"`）而本项目未装，删掉该行（地基不需要）。

> 这是「移植 + 替换字体加载」，不是逐行新写——以原型 `styles.css` 为来源，只改字体相关。

- [ ] **Step 3：建 `src/renderer/global.d.ts`**

```ts
import type { RendererApi } from "../preload";

declare global {
  interface Window {
    api: RendererApi;
  }
}

// @fontsource 包是 side-effect CSS、无 TS 类型——声明为模块以过 typecheck。
declare module "@fontsource-variable/manrope";
declare module "@fontsource-variable/fraunces";

export {};
```

> `import type` 仅取类型、编译时擦除，不会把 `electron` 运行时引入 renderer。

- [ ] **Step 4：typecheck**

Run: `pnpm typecheck`
Expected: 无新错（`window.api` 类型可解析）。

- [ ] **Step 5：提交**

```bash
git add index.html src/index.css src/renderer/global.d.ts
git commit -m "feat(renderer): html root, tailwind4 global styles, window.api typing"
```

---

## Task 4：`cn` + QueryClient + 查询键工厂（含单测）

**Files:** `src/renderer/lib/utils.ts`(+test)、`src/renderer/query/client.ts`、`src/renderer/query/keys.ts`(+test)

- [ ] **Step 1：写失败测试 `src/renderer/lib/utils.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { cn } from "@renderer/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });
  it("dedupes conflicting tailwind classes (last wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("drops falsy values", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });
});
```

- [ ] **Step 2：写失败测试 `src/renderer/query/keys.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { qk } from "@renderer/query/keys";

describe("qk", () => {
  it("static keys", () => {
    expect(qk.library).toEqual(["library"]);
    expect(qk.providers).toEqual(["providers"]);
    expect(qk.assistantDefault).toEqual(["assistant", "default"]);
  });
  it("parametric keys", () => {
    expect(qk.toc("b1")).toEqual(["toc", "b1"]);
    expect(qk.chapter("b1", "c1")).toEqual(["chapter", "b1", "c1"]);
    expect(qk.conversations("b1")).toEqual(["conversations", "b1"]);
    expect(qk.messages("conv1")).toEqual(["messages", "conv1"]);
  });
});
```

- [ ] **Step 3：跑确认失败**

Run: `pnpm test src/renderer/lib/utils.test.ts src/renderer/query/keys.test.ts`
Expected: FAIL（模块未定义）。

- [ ] **Step 4：实现 `src/renderer/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5：实现 `src/renderer/query/keys.ts`**

```ts
/** 查询键工厂——与 spec §6.3 约定一致。 */
export const qk = {
  library: ["library"] as const,
  toc: (bookId: string) => ["toc", bookId] as const,
  chapter: (bookId: string, chapterId: string) => ["chapter", bookId, chapterId] as const,
  providers: ["providers"] as const,
  assistantDefault: ["assistant", "default"] as const,
  conversations: (bookId: string) => ["conversations", bookId] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
};
```

- [ ] **Step 6：实现 `src/renderer/query/client.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";

/** 适配本地 IPC（非网络）：不 focus 重验、本地确定性数据高 staleTime、失败不重试。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    },
  },
});
```

- [ ] **Step 7：跑测试确认通过**

Run: `pnpm test src/renderer/lib/utils.test.ts src/renderer/query/keys.test.ts`
Expected: 全 PASS。

- [ ] **Step 8：提交**

```bash
git add src/renderer/lib/utils.ts src/renderer/lib/utils.test.ts src/renderer/query/client.ts src/renderer/query/keys.ts src/renderer/query/keys.test.ts
git commit -m "feat(renderer): add cn util, query client and key factory"
```

---

## Task 5：zustand reader-store + settings-store（含单测）

**Files:** `src/renderer/types.ts`、`src/renderer/store/reader-store.ts`(+test)、`src/renderer/store/settings-store.ts`

- [ ] **Step 1：建 `src/renderer/types.ts`（renderer UI 本地类型）**

```ts
/** 选区信息（S3 由 ReaderPane 写入；字段对齐 @shared/chat 的 buildChipsInput）。 */
export interface SelectionInfo {
  selectionText: string;
  paragraphBefore: string | null;
  paragraphCurrent: string;
  paragraphAfter: string | null;
  /** 选区锚点矩形（浮动工具栏定位用；S3 填充）。 */
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface ReaderPrefs {
  fontScale: number;
  lineHeight: number;
  maxWidth: number;
}
```

- [ ] **Step 2：写失败测试 `src/renderer/store/reader-store.test.ts`**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useReaderStore, READER_INITIAL } from "@renderer/store/reader-store";

beforeEach(() => useReaderStore.setState(READER_INITIAL, true));

describe("reader-store", () => {
  it("openBook switches to reader view with ids", () => {
    useReaderStore.getState().openBook("b1", "c1");
    const s = useReaderStore.getState();
    expect(s.view).toBe("reader");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBe("c1");
  });
  it("backToLibrary resets view", () => {
    useReaderStore.getState().openBook("b1", "c1");
    useReaderStore.getState().backToLibrary();
    expect(useReaderStore.getState().view).toBe("library");
  });
  it("setActiveConversation stores id", () => {
    useReaderStore.getState().setActiveConversation("conv1");
    expect(useReaderStore.getState().activeConversationId).toBe("conv1");
  });
  it("updatePrefs merges", () => {
    useReaderStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(useReaderStore.getState().prefs.fontScale).toBe(1.2);
    expect(useReaderStore.getState().prefs.maxWidth).toBe(READER_INITIAL.prefs.maxWidth);
  });
});
```

- [ ] **Step 3：跑确认失败**

Run: `pnpm test src/renderer/store/reader-store.test.ts`
Expected: FAIL（模块未定义）。

- [ ] **Step 4：实现 `src/renderer/store/reader-store.ts`**

```ts
import { create } from "zustand";
import type { Chip } from "@shared/chat";
import type { ReaderPrefs, SelectionInfo } from "@renderer/types";

interface ReaderState {
  view: "library" | "reader";
  currentBookId: string | null;
  currentChapterId: string | null;
  selection: SelectionInfo | null;
  prefs: ReaderPrefs;
  activeConversationId: string | null;
  panelOpen: boolean;
  sidebarOpen: boolean;
  draftChips: Chip[];
  draftText: string;
}

interface ReaderActions {
  openBook: (bookId: string, chapterId: string) => void;
  backToLibrary: () => void;
  setCurrentChapter: (chapterId: string) => void;
  setSelection: (selection: SelectionInfo | null) => void;
  setActiveConversation: (id: string | null) => void;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setPanelOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
}

export const READER_INITIAL: ReaderState = {
  view: "library",
  currentBookId: null,
  currentChapterId: null,
  selection: null,
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640 },
  activeConversationId: null,
  panelOpen: false,
  sidebarOpen: true,
  draftChips: [],
  draftText: "",
};

export const useReaderStore = create<ReaderState & ReaderActions>((set) => ({
  ...READER_INITIAL,
  openBook: (currentBookId, currentChapterId) =>
    set({ view: "reader", currentBookId, currentChapterId, activeConversationId: null }),
  backToLibrary: () => set({ view: "library" }),
  setCurrentChapter: (currentChapterId) => set({ currentChapterId }),
  setSelection: (selection) => set({ selection }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  updatePrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
}));
```

- [ ] **Step 5：实现 `src/renderer/store/settings-store.ts`**（设置面板纯 UI 态；provider/assistant 持久态走 Query）

```ts
import { create } from "zustand";

interface SettingsState {
  open: boolean;
  /** 最近一次连通测试结果显示（null = 未测）。 */
  testResult: { ok: boolean; message?: string } | null;
}

interface SettingsActions {
  setOpen: (open: boolean) => void;
  setTestResult: (result: SettingsState["testResult"]) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  testResult: null,
  setOpen: (open) => set({ open }),
  setTestResult: (testResult) => set({ testResult }),
}));
```

- [ ] **Step 6：跑测试确认通过**

Run: `pnpm test src/renderer/store/reader-store.test.ts`
Expected: 全 PASS。

- [ ] **Step 7：提交**

```bash
git add src/renderer/types.ts src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts src/renderer/store/settings-store.ts
git commit -m "feat(renderer): add zustand reader and settings stores"
```

---

## Task 6：React 挂载入口 + 最小两栏壳

**Files:** `src/renderer.ts`→`src/renderer.tsx`、`src/renderer/App.tsx`

- [ ] **Step 1：删除 `src/renderer.ts`，新建 `src/renderer.tsx`**

```tsx
import "@fontsource-variable/manrope";
import "@fontsource-variable/fraunces";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@renderer/query/client";
import { App } from "@renderer/App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("renderer: #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

> 用 `git mv src/renderer.ts src/renderer.tsx` 后改写内容（保留 git 历史）；`index.html` 已在 Task 3 指向 `renderer.tsx`。核对 `@fontsource-variable/manrope`/`fraunces` 的入口 import 路径（默认 import 即加载可变字体 + `@font-face`）。

- [ ] **Step 2：建 `src/renderer/App.tsx`（最小两栏壳，验证 window.api + Query + Tailwind + 字体）**

```tsx
import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";

export function App() {
  const library = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });

  return (
    <div className="flex h-screen bg-background font-sans text-foreground">
      <aside className="w-64 shrink-0 border-r border-border p-4">
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <p className="mt-1 text-sm text-muted-foreground">书库</p>
        {library.isPending && <p className="mt-4 text-sm">加载中…</p>}
        {library.isError && <p className="mt-4 text-sm text-destructive">读取书库失败</p>}
        <ul className="mt-4 space-y-1">
          {library.data?.map((b) => (
            <li key={b.id} className="truncate text-sm">
              {b.title ?? b.id}
            </li>
          ))}
          {library.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">（空——导入功能见 Plan 3）</li>
          )}
        </ul>
      </aside>
      <main className="flex-1 p-8">
        <p className="font-serif text-lg">渲染层地基就绪（S1）。</p>
      </main>
    </div>
  );
}
```

> `bg-background`/`text-foreground`/`border-border`/`text-muted-foreground`/`text-destructive` 来自移植进 `index.css` 的 `@theme` 色彩变量。若某 token 名与移植后的不一致，按 `index.css` 里实际的 `--color-*` 命名对齐。

- [ ] **Step 3：typecheck + lint + test 全量把关**

Run: `pnpm typecheck ; pnpm lint ; pnpm test`
Expected: typecheck 仅剩预存 `forge.config.ts` 错误；lint 0；test 全绿（含新增 renderer 纯逻辑测）。

- [ ] **Step 4：提交**

```bash
git add src/renderer.tsx src/renderer/App.tsx
git commit -m "feat(renderer): mount React app with minimal two-pane shell"
```

---

## 全量验收（Plan 2 完成判据）

- [ ] `pnpm typecheck`：除预存 `forge.config.ts` 外 0 错。
- [ ] `pnpm lint`：0 错。
- [ ] `pnpm test`：全绿（含 `cn`/`qk`/reader-store 新测）。
- [ ] **用户手测**（implementer 不做）：`pnpm start` → 窗口出现，左栏显示「Marginalia/书库」、主栏显示「渲染层地基就绪」，字体为 Manrope/Fraunces，Tailwind 样式生效，控制台无报错。手测后 `pnpm db:rebuild:node` 恢复测试 ABI。

> Plan 2 只搭地基；导入/读正文（S2）与设置 UI（S-prov）见 Plan 3，选区链+端到端（S3+S4）见 Plan 4。
