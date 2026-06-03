# ReaderView 三向可收起布局实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 [spec](../specs/2026-06-04-reader-collapsible-layout-design.md) 实现 ReaderView 左栏 / AI 面板 / header 三向可收起布局（PeekDrawer 交互、单挂载点保活、readerLayout 持久化）。

**Architecture:** 新组件 `CollapsiblePane` 单挂载点切换「文档流占位 / 贴边浮层抽屉」两种 className 模式（children 不卸载，保住 AIPanel `useChat` 流式状态）；三态收口为 `readerLayout` 单 preference key 存 prefs-store（落盘 + 启动 hydrate）；`chat-store.panelOpen` 迁移至 prefs-store。

**Tech Stack:** React 19（已启 React Compiler，勿手写 useCallback/useMemo）+ zustand + Tailwind v4 + Zod 4 + vitest 4（Node 环境，仅 `*.test.ts`，组件不进单测）。

**执行环境注意：**

- 在当前 worktree（分支 `worktree-crystalline-frolicking-kettle`）执行，勿 cd 出去。
- `git commit` 触发 prek：若 format hook 把提交打回（"files were modified by this hook"），`git add` 被改文件后**重跑同一条 commit 命令**（第二次会过）。
- i18n：新增 `t()` 后须 `pnpm i18n:extract`（**先于 typecheck**——locales 是类型源）；en 翻译要手工补。

---

### Task 1: `readerLayout` preference 注册（shared，TDD）

**Files:**

- Modify: `src/shared/preferences.ts`
- Test: `src/shared/preferences.test.ts`

- [ ] **Step 1: 写失败测试**

`src/shared/preferences.test.ts` 三处改动：

① import 加 `readerLayoutSchema`：

```ts
import {
  PREFERENCE_SCHEMAS,
  preferenceKey,
  readerLayoutSchema,
  readerPrefsSchema,
  setPreferenceInput,
} from "@shared/preferences";
```

② `"registers exactly the keys with current consumers"` 的期望数组改为（按字母序）：

```ts
expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
  "autoSummarize",
  "colorMode",
  "language",
  "lastHighlightStyle",
  "readerLayout",
  "readerPrefs",
]);
```

③ 在 `describe("preferences schemas", …)` 内追加一条用例（放在 `"lastHighlightStyle validates…"` 之后）：

```ts
it("readerLayoutSchema requires all three boolean flags", () => {
  expect(
    readerLayoutSchema.safeParse({ sidebarOpen: true, panelOpen: false, headerOpen: true }).success,
  ).toBe(true);
  expect(readerLayoutSchema.safeParse({ sidebarOpen: true, panelOpen: false }).success).toBe(false);
  expect(
    readerLayoutSchema.safeParse({ sidebarOpen: 1, panelOpen: false, headerOpen: true }).success,
  ).toBe(false);
});
```

④ `"setPreferenceInput validates value per key at the boundary"` 用例末尾追加：

```ts
expect(
  setPreferenceInput.safeParse({
    key: "readerLayout",
    value: { sidebarOpen: true, panelOpen: false, headerOpen: true },
  }).success,
).toBe(true);
expect(
  setPreferenceInput.safeParse({ key: "readerLayout", value: { sidebarOpen: true } }).success,
).toBe(false);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: FAIL —— `readerLayoutSchema` 未导出（import 报错）。

- [ ] **Step 3: 最小实现**

`src/shared/preferences.ts`：在 `colorMode` 定义之后、`PREFERENCE_SCHEMAS` 之前加：

```ts
/** 阅读器三向布局开关（左栏 / AI 面板 / 顶栏），整对象落盘、重启恢复。 */
export const readerLayoutSchema = z.object({
  sidebarOpen: z.boolean(),
  panelOpen: z.boolean(),
  headerOpen: z.boolean(),
});
export type ReaderLayout = z.infer<typeof readerLayoutSchema>;
```

`PREFERENCE_SCHEMAS` 加一行（`readerPrefs` 之后）：

```ts
readerLayout: readerLayoutSchema,
```

`setPreferenceInput` 判别联合补 arm（`readerPrefs` arm 之后）：

```ts
z.object({ key: z.literal("readerLayout"), value: readerLayoutSchema }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: PASS（全绿，含既有 drift 同步用例）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts
git commit -m "feat(shared): register readerLayout preference key"
```

---

### Task 2: prefs-store `layout` 状态 + hydrate（TDD）

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`
- Modify: `src/renderer/types.ts`
- Test: `src/renderer/store/prefs-store.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/store/prefs-store.test.ts`：

① 顶部 import 改为（引入被 mock 的 `persistPreference` 以便断言）：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/store/persist-preference", () => ({ persistPreference: vi.fn() }));

import { persistPreference } from "@renderer/store/persist-preference";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";

beforeEach(() => {
  usePrefsStore.setState(PREFS_INITIAL);
  vi.clearAllMocks();
});
```

② `describe("prefs-store", …)` 内追加用例：

```ts
it("updateLayout merges patch, keeps other flags, persists whole object", () => {
  usePrefsStore.getState().updateLayout({ panelOpen: true });
  expect(usePrefsStore.getState().layout).toEqual({
    sidebarOpen: true,
    panelOpen: true,
    headerOpen: true,
  });
  expect(persistPreference).toHaveBeenCalledWith({
    key: "readerLayout",
    value: { sidebarOpen: true, panelOpen: true, headerOpen: true },
  });
});
it("layout defaults to sidebar+header open, panel closed", () => {
  expect(PREFS_INITIAL.layout).toEqual({
    sidebarOpen: true,
    panelOpen: false,
    headerOpen: true,
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: FAIL —— `updateLayout` / `layout` 不存在。

- [ ] **Step 3: 最小实现**

`src/renderer/types.ts` 末行改为同时再导出 `ReaderLayout`：

```ts
// ReaderPrefs / ReaderLayout 收口到 @shared/preferences 的 Zod schema（单一源，供 preferences 表持久化）。
export type { ReaderLayout, ReaderPrefs } from "@shared/preferences";
```

`src/renderer/store/prefs-store.ts`：

① import 行改：`import type { ReaderLayout, ReaderPrefs } from "@renderer/types";`

② `PrefsState` 加字段、`PrefsActions` 加 action：

```ts
/** 阅读器三向布局开关（左栏 / AI 面板 / 顶栏）；落盘记忆，重启恢复。 */
layout: ReaderLayout;
```

```ts
  updateLayout: (patch: Partial<ReaderLayout>) => void;
```

③ `PREFS_INITIAL` 加初值（DD-4 首启默认）：

```ts
  layout: { sidebarOpen: true, panelOpen: false, headerOpen: true },
```

④ store 创建体加 action（仿 `updatePrefs`）：

```ts
  updateLayout: (patch) =>
    set((s) => {
      const layout = { ...s.layout, ...patch };
      persistPreference({ key: "readerLayout", value: layout });
      return { layout };
    }),
```

`src/renderer/store/hydrate-preferences.ts` 在 `snap.readerPrefs` 一行后加：

```ts
if (snap.readerLayout) usePrefsStore.setState({ layout: snap.readerLayout });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/prefs-store.test.ts src/renderer/store/hydrate-preferences.ts src/renderer/types.ts
git commit -m "feat(renderer): add readerLayout state to prefs-store with hydrate"
```

---

### Task 3: `panelOpen` 从 chat-store 迁移到 prefs-store

**Files:**

- Modify: `src/renderer/store/chat-store.ts`
- Modify: `src/renderer/ai/use-ai-actions.ts`
- Modify: `src/renderer/ai/Composer.tsx`
- Modify: `src/renderer/ai/AIPanel.tsx`
- Modify: `src/renderer/ai/SummaryPill.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx`（仅换状态源，布局重构在 Task 5）
- Test: `src/renderer/store/chat-store.test.ts`

- [ ] **Step 1: 改 chat-store 与其测试**

`src/renderer/store/chat-store.ts`：

① 删 `ChatState.panelOpen`、`ChatActions.setPanelOpen`、`CHAT_INITIAL.panelOpen`、store 体的 `setPanelOpen` 实现——四处整行删除。

② **`openConversation` 的「开面板」语义保留**（main 上新增：重开历史会话要自动弹出面板）——其 `set()` 内的 `panelOpen: true,` 一行删除，改为在 `set()` 之前跨 store 调用。整个 action 改为：

```ts
  openConversation: (id, chapterId) => {
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    return set((s) => ({
      activeConversationId: id,
      activeConversationChapterId: chapterId,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    }));
  },
```

并加 import：`import { usePrefsStore } from "@renderer/store/prefs-store";`（无循环依赖——prefs-store 只 import persist-preference 与 types；persistPreference 在无 `window` 的 headless 测试里自动 no-op）。action 上方注释同步改为：`/** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板（经 prefs-store 布局）。 */`

`src/renderer/store/chat-store.test.ts`：

① 整块删除用例：

```ts
it("setPanelOpen toggles", () => {
  useChatStore.getState().setPanelOpen(true);
  expect(useChatStore.getState().panelOpen).toBe(true);
});
```

② `describe("openConversation")` 两条用例改为断言 prefs-store（`panelOpen` 已不在 chat-store）。文件顶部加 import 与重置：

```ts
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";

beforeEach(() => {
  useChatStore.setState(CHAT_INITIAL);
  usePrefsStore.setState(PREFS_INITIAL);
});
```

（原 `beforeEach(() => useChatStore.setState(CHAT_INITIAL));` 替换为上面块。）两条用例中的 `expect(s1.panelOpen).toBe(true);` / `expect(s.panelOpen).toBe(true);` 均改为：

```ts
expect(usePrefsStore.getState().layout.panelOpen).toBe(true);
```

（用例内自带的 `useChatStore.setState(CHAT_INITIAL);` 行可顺手删——beforeEach 已覆盖。）

- [ ] **Step 2: 迁移 5 个组件/hook 消费方**

① `src/renderer/ai/use-ai-actions.ts`：加 import `import { usePrefsStore } from "@renderer/store/prefs-store";`；解构行（现第 24 行）改为 `const { setDraftChips, setDraftText } = useChatStore.getState();`；`setPanelOpen(true);`（现第 47 行）改为：

```ts
usePrefsStore.getState().updateLayout({ panelOpen: true });
```

② `src/renderer/ai/Composer.tsx`：加 import `import { usePrefsStore } from "@renderer/store/prefs-store";`；`const panelOpen = useChatStore((s) => s.panelOpen);` 改为：

```ts
const panelOpen = usePrefsStore((s) => s.layout.panelOpen);
```

（`useChatStore` import 保留——draft 系列仍用。）

③ `src/renderer/ai/AIPanel.tsx`：加 import `import { usePrefsStore } from "@renderer/store/prefs-store";`；`const setPanelOpen = useChatStore((s) => s.setPanelOpen);` 改为：

```ts
const updateLayout = usePrefsStore((s) => s.updateLayout);
```

关闭按钮 `onClick={() => setPanelOpen(false)}`（现第 111 行）改为 `onClick={() => updateLayout({ panelOpen: false })}`。（`useChatStore` import 保留——`setActiveConversation`/`openCommand`/`activeConversationId` 仍用。）

④ `src/renderer/ai/SummaryPill.tsx`：`import { useChatStore } from "@renderer/store/chat-store";` 整行换为 `import { usePrefsStore } from "@renderer/store/prefs-store";`；`const panelOpen = useChatStore((s) => s.panelOpen);` 改为：

```ts
const panelOpen = usePrefsStore((s) => s.layout.panelOpen);
```

⑤ `src/renderer/reader/ReaderView.tsx`（最小替换，保持现有 JSX）：

```ts
const panelOpen = usePrefsStore((s) => s.layout.panelOpen);
const updateLayout = usePrefsStore((s) => s.updateLayout);
```

替换原 26-27 行的两个 chat-store 选择器；第 70 行 `onClick={() => setPanelOpen(!panelOpen)}` 改 `onClick={() => updateLayout({ panelOpen: !panelOpen })}`；删除 `import { useChatStore } from "@renderer/store/chat-store";`（本文件已无其他用途）。`usePrefsStore` import 已存在（`autoSummarize` 在用）。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 全 PASS（特别是 chat-store.test.ts 与全仓无 `setPanelOpen` 残留：`grep -rn "setPanelOpen" src/` 应零结果）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/chat-store.ts src/renderer/store/chat-store.test.ts src/renderer/ai/use-ai-actions.ts src/renderer/ai/Composer.tsx src/renderer/ai/AIPanel.tsx src/renderer/ai/SummaryPill.tsx src/renderer/reader/ReaderView.tsx
git commit -m "refactor(renderer): move panelOpen from chat-store to prefs-store layout"
```

---

### Task 4: `CollapsiblePane` 组件（新）

**Files:**

- Create: `src/renderer/reader/CollapsiblePane.tsx`

无单测（vitest Node 环境无 DOM；行为靠 Task 6 冒烟）。

- [ ] **Step 1: 写组件（完整文件内容）**

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

/** 三向收起的物理类映射（DD-6：定位/位移/边框统一物理坐标——transform 无逻辑变体）。 */
const PEEK = {
  left: {
    pinned: "border-r",
    trigger: "inset-y-0 left-0 w-3",
    handle: "inset-y-0 left-0 w-1",
    drawer: "inset-y-0 left-0 border-r",
    closed: "-translate-x-full",
  },
  right: {
    pinned: "border-l",
    trigger: "inset-y-0 right-0 w-3",
    handle: "inset-y-0 right-0 w-1",
    drawer: "inset-y-0 right-0 border-l",
    closed: "translate-x-full",
  },
  top: {
    pinned: "border-b",
    trigger: "inset-x-0 top-0 h-3",
    handle: "inset-x-0 top-0 h-1",
    drawer: "inset-x-0 top-0 border-b",
    closed: "-translate-y-full",
  },
} as const;

interface CollapsiblePaneProps {
  side: "left" | "right" | "top";
  /** 钉住（true=文档流占位；false=收起为边缘 peek 抽屉）。 */
  open: boolean;
  /** 面板尺寸类（如 "w-64" / "w-96" / "h-12"）。 */
  sizeClass: string;
  /** 收起态边缘热区的 aria-label。 */
  label: string;
  /** 追加到面板元素的类（两种模式都生效，如左栏 bg-muted/30）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 三向可收起面板（UP1 PeekDrawer 的单挂载点版）：钉住时在文档流占位；收起时同一元素
 * 切为贴边浮层抽屉——hover 3px 边缘热区滑出、移开 200ms 收回。children 树位置不变，
 * 开合不卸载（AIPanel 的 useChat 流式状态、Sidebar 滚动位置得以保活）。
 * 收起且未唤出时面板置 inert，挡掉离屏内容的 Tab 焦点与指针事件。
 */
export function CollapsiblePane({
  side,
  open,
  sizeClass,
  label,
  className,
  children,
}: CollapsiblePaneProps) {
  const [peekOpen, setPeekOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const c = PEEK[side];

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setPeekOpen(false), 200);
  };

  // 钉住时复位 peek 态；开合切换与卸载时清掉未决的收回计时器。
  useEffect(() => {
    if (open) setPeekOpen(false);
    return cancelClose;
  }, [open]);

  return (
    <>
      {/* 收起态：边缘 3px 热区 + 1px 常驻把手（hover 高亮并唤出抽屉） */}
      {!open && (
        <div
          aria-label={label}
          onMouseEnter={() => {
            cancelClose();
            setPeekOpen(true);
          }}
          className={cn("group absolute z-30", c.trigger)}
        >
          <div
            className={cn(
              "absolute bg-border/60 transition-colors group-hover:bg-primary/40",
              c.handle,
            )}
          />
        </div>
      )}

      {/* 面板本体：单挂载点，仅切 className（钉住=文档流；收起=贴边抽屉浮层） */}
      <div
        inert={!open && !peekOpen}
        onMouseEnter={open ? undefined : cancelClose}
        onMouseLeave={open ? undefined : scheduleClose}
        className={cn(
          "border-border",
          open
            ? cn("shrink-0", c.pinned)
            : cn(
                "absolute z-40 bg-background shadow-xl transition-transform duration-200 ease-out",
                c.drawer,
                peekOpen ? "translate-x-0 translate-y-0" : c.closed,
              ),
          sizeClass,
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（React 19 的 `inert` 接受 boolean；若 typecheck 对 `inert` 报错说明 @types/react 版本未到 19，改用 `{...(!open && !peekOpen ? { inert: true } : {})}` 兜底——预期不需要）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/CollapsiblePane.tsx
git commit -m "feat(renderer): add CollapsiblePane three-way peek drawer"
```

---

### Task 5: ReaderView 三向接线 + header 按钮编排 + i18n

**Files:**

- Modify: `src/renderer/reader/ReaderView.tsx`（整文件重写如下）
- Modify: `src/shared/i18n/locales/zh-CN.ts`、`src/shared/i18n/locales/en.ts`（经 `pnpm i18n:extract` + 手工补 en）

- [ ] **Step 1: 重写 ReaderView.tsx（完整文件内容）**

```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
  Settings,
} from "lucide-react";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { CollapsiblePane } from "@renderer/reader/CollapsiblePane";
import { Sidebar } from "@renderer/reader/Sidebar";
import { EpubReader } from "@renderer/reader/EpubReader";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";
import { SelectionToolbar } from "@renderer/reader/SelectionToolbar";
import { HighlightStyleBar } from "@renderer/reader/HighlightStyleBar";
import { NoteModal } from "@renderer/reader/NoteModal";
import { AIPanel } from "@renderer/ai/AIPanel";

export function ReaderView() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const layout = usePrefsStore((s) => s.layout);
  const updateLayout = usePrefsStore((s) => s.updateLayout);
  const qc = useQueryClient();

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 开章自动生成摘要（设置开启时）：停在某章 ~800ms 才触发，避免快速翻阅时为每章都生成。
  // 注：当前章 id 现由 EpubReader 据滚动位置回写（onTopSectionChange），不再在此回填首章——
  // 否则开书时强设首章会覆盖 EpubReader 的 CFI 进度恢复（initialIndex）。
  // 主进程 ensureChapterSummary 仅从 pending 起，故对已就绪章重复触发是廉价 no-op。
  useEffect(() => {
    if (!autoSummarize || bookId == null || chapterId == null) return;
    const t = setTimeout(() => {
      void window.api.content
        .generateChapterSummary({ bookId, chapterId })
        .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [autoSummarize, bookId, chapterId, qc]);

  if (!bookId) return null;

  const sidebarLabel = layout.sidebarOpen
    ? t("reader.collapseSidebar", "收起侧栏")
    : t("reader.expandSidebar", "展开侧栏");
  const panelLabel = layout.panelOpen
    ? t("reader.collapseAiPanel", "收起 AI 面板")
    : t("reader.expandAiPanel", "展开 AI 面板");
  const headerLabel = layout.headerOpen
    ? t("reader.collapseHeader", "收起顶栏")
    : t("reader.expandHeader", "展开顶栏");

  return (
    <div className="relative flex h-screen flex-col bg-background font-sans text-foreground">
      <CollapsiblePane
        side="top"
        open={layout.headerOpen}
        sizeClass="h-12"
        label={t("reader.expandHeader", "展开顶栏")}
      >
        <header className="flex h-full items-center justify-between px-3">
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => updateLayout({ sidebarOpen: !layout.sidebarOpen })}
                    aria-label={sidebarLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </TooltipTrigger>
              <TooltipContent>{sidebarLabel}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              onClick={backToLibrary}
              className="text-muted-foreground"
            >
              <ArrowLeft />
              {t("reader.backToLibrary", "书库")}
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <ReaderPrefs />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => updateLayout({ panelOpen: !layout.panelOpen })}
                    aria-label={panelLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </TooltipTrigger>
              <TooltipContent>{panelLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openSettings(true)}
                    aria-label={t("settings.title", "设置")}
                    className="text-muted-foreground"
                  />
                }
              >
                <Settings />
              </TooltipTrigger>
              <TooltipContent>{t("settings.title", "设置")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => updateLayout({ headerOpen: !layout.headerOpen })}
                    aria-label={headerLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.headerOpen ? <PanelTopClose /> : <PanelTopOpen />}
              </TooltipTrigger>
              <TooltipContent>{headerLabel}</TooltipContent>
            </Tooltip>
          </div>
        </header>
      </CollapsiblePane>
      {/* overflow-hidden：收起抽屉以 translate 藏出容器边缘，不裁剪会撑出横向滚动。 */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <CollapsiblePane
          side="left"
          open={layout.sidebarOpen}
          sizeClass="w-64"
          className="bg-muted/30"
          label={t("reader.expandSidebar", "展开侧栏")}
        >
          <Sidebar bookId={bookId} />
        </CollapsiblePane>
        <main className="min-w-0 flex-1">
          {/* 无条件渲染：EpubReader 自管载入/错误态，并据 CFI 进度恢复初始位置（不门控在 chapterId 上，
              否则需先有当前章才渲染，与「开书即按进度连续渲染」相悖）。 */}
          <EpubReader bookId={bookId} chapters={chapters.data ?? []} />
        </main>
        <CollapsiblePane
          side="right"
          open={layout.panelOpen}
          sizeClass="w-96"
          label={t("reader.expandAiPanel", "展开 AI 面板")}
        >
          <AIPanel />
        </CollapsiblePane>
      </div>
      <SelectionToolbar />
      <HighlightStyleBar />
      <NoteModal />
    </div>
  );
}
```

要点说明（对实现者）：

- 左栏原 `bg-muted/30` 经 `className` 传入（钉住/抽屉两态同底色）；AIPanel 自带 `bg-muted/30` 不用传。
- 原 `border-e`/`border-s` 改由 CollapsiblePane 的物理 `border-r`/`border-l` 提供（DD-6）。
- 旧 `cn` import、`MessageSquare`、chat-store 引用均已不再需要——上面文件内容即终态，照写即可。
- 收起 header 后，浮层内最右按钮即 `PanelTopOpen`（恢复钉住的唯一途径，与原型一致）。

- [ ] **Step 2: i18n 提取与 en 补翻**

Run: `pnpm i18n:extract`
Expected: `src/shared/i18n/locales/zh-CN.ts` 新增 6 个键（值取代码内默认文案）：`reader.collapseSidebar` 收起侧栏 / `reader.expandSidebar` 展开侧栏 / `reader.collapseAiPanel` 收起 AI 面板 / `reader.expandAiPanel` 展开 AI 面板 / `reader.collapseHeader` 收起顶栏 / `reader.expandHeader` 展开顶栏；旧键 `reader.aiPanel` 因不再被引用而被移除（先 `grep -rn "reader.aiPanel" src/` 确认无其他引用）。

手工补 `src/shared/i18n/locales/en.ts`（extract 对次语言只占位）：

```ts
  "reader.collapseSidebar": "Collapse sidebar",
  "reader.expandSidebar": "Expand sidebar",
  "reader.collapseAiPanel": "Collapse AI panel",
  "reader.expandAiPanel": "Expand AI panel",
  "reader.collapseHeader": "Collapse header",
  "reader.expandHeader": "Expand header",
```

（同时删除 en 中残留的 `reader.aiPanel`，若 extract 未自动清。）

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/ReaderView.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(renderer): wire three-way collapsible layout in ReaderView"
```

（若 extract 还动了 `src/shared/i18n/i18next.d.ts` 等生成物，一并 add。）

---

### Task 6: 冒烟验证（pnpm start）

**Files:** 无代码改动；按 spec §6 手测清单逐项验证。

- [ ] **Step 1: 启动应用**

Run: `pnpm start`（阻塞；GUI 冒烟）

- [ ] **Step 2: 逐项过清单**

- 三向各自：header 按钮收起 → 边缘现 1px 把手 / hover 3px 热区滑出浮层 / 移开 200ms 收回、期间移回则取消 / 浮层内点击钉住按钮恢复占位
- AI 回复流式中收起右栏 → hover 唤出，回复仍在流式渲染（保活）
- 重启应用恢复上次布局；清 userData（dev 为 `marginalia-dev`）后首启默认「左开/顶开/右关」
- 选区提问：右栏收起时自动钉住展开、输入框聚焦
- 全收起：正文满屏可读，三边把手均可唤出；正文无横向滚动条（overflow-hidden 生效）

- [ ] **Step 3: 结果记录**

冒烟全过 → 走 finishing 流程（superpowers:finishing-a-development-branch：rebase 进本地 main、更新 ROADMAP）。发现问题 → 修复后重过相应项。

---

## Self-Review 备忘（计划作者已核）

- spec 覆盖：DD-1→Task 4 PEEK 参数；DD-2→Task 4 单挂载点+inert；DD-3→Task 1/2/3；DD-4→Task 2 初值；DD-5→无快捷键任务（范围外）；DD-6→Task 4 物理类；DD-7→Task 5 按钮编排。§7 风险中 overflow 问题以 Task 5 的 `overflow-hidden` 兜底。
- 类型一致：`ReaderLayout`（Task 1 定义/导出 → Task 2 store 与 types 再导出 → Task 5 使用）；`updateLayout(patch)` 签名各任务一致。
- 无占位符；所有代码块为终态内容。
