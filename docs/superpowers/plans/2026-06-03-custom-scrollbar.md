# 类 macOS 自绘滚动条 + 阅读区无条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阅读区彻底隐藏滚动条；其余 7 处外壳容器换成 Base UI ScrollArea 原语，呈现可拖拽、滚动/悬停淡入淡出的 macOS 风细 overlay 条。

**Architecture:** 新增一个 shadcn 风包装组件 `components/ui/scroll-area.tsx`（包 `@base-ui/react/scroll-area`），把每个裸 `overflow-y-auto` 容器重构成 `Root > Viewport > Content` 结构、滚动责任移到 Viewport；阅读区（react-virtuoso）则给 Virtuoso 的 scroller 套现有 `.no-scrollbar` 全局类、不要任何 thumb。

**Tech Stack:** React 19（启用 React Compiler，**勿手写 useCallback/useMemo**）、`@base-ui/react` `^1.5.0`、Tailwind v4、react-virtuoso、TypeScript 6 strict。

---

## 关键约定（贯穿全程）

- **无新单测**：thumb 数学/拖拽/淡入淡出全由 Base UI 拥有，本功能无纯逻辑可测（与封面墙、右键删书组件「手测」一致）。每个代码任务的自动门是 **`pnpm typecheck` + `pnpm lint`**，视觉正确性靠 Task 10 手测。
- **提交即 conventional commits**；pre-commit 钩子（prek）会跑 `lint:fix` + `format`，若报「files were modified by this hook」就 `git add` 被改文件再重跑同一条 commit（第二次过）。
- **包装组件约定**：仿 `src/renderer/components/ui/popover.tsx`——`"use client"` + 具名 `import { X as XPrimitive } from "@base-ui/react/<part>"` + `cn` + `data-slot`。Base UI 用 `render` prop（**非 Slot**）。
- **Base UI 已装**（`@base-ui/react@^1.5.0`），新增的是子路径导入，**无新依赖**，不触发重装、不需 `db:rebuild:electron`。
- **路径别名**：渲染层用 `@renderer/*`、`@shared/*`。
- **DRY 修正**：spec §2 原计划新增 `@utility scrollbar-hide`，但 `src/index.css:259` 已有等价的 `.no-scrollbar` 全局类——**复用它**，不新增 CSS。

---

## 文件结构

| 文件                                         | 责任                                                                                                 | 动作 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---- |
| `src/renderer/components/ui/scroll-area.tsx` | macOS 风 ScrollArea 包装（Root/Viewport/Content + Scrollbar/Thumb），导出 `ScrollArea` + `ScrollBar` | 新建 |
| `packages/virtual-docs/src/VirtualDocs.tsx`  | 加 `className?` 透传给 `<Virtuoso>`（epub-agnostic，不内置隐条语义）                                 | 改   |
| `src/renderer/reader/EpubReader.tsx`         | 给 VirtualDocs 传 `className="no-scrollbar"`                                                         | 改   |
| `src/renderer/reader/ChapterList.tsx`        | 侧栏 TOC 换 ScrollArea                                                                               | 改   |
| `src/renderer/reader/AnnotationsList.tsx`    | 侧栏标注列表换 ScrollArea                                                                            | 改   |
| `src/renderer/library/LibraryView.tsx`       | 书库网格换 ScrollArea                                                                                | 改   |
| `src/renderer/ai/AIPanel.tsx`                | 消息流换 ScrollArea，`scrollRef` 接 Viewport 保自动滚底                                              | 改   |
| `src/renderer/settings/SettingsShell.tsx`    | nav + 内容面板两处换 ScrollArea，关闭按钮提为固定                                                    | 改   |
| `src/renderer/reader/BookCard.tsx`           | 摘要卡 `max-h-96` 换 ScrollArea                                                                      | 改   |
| `src/renderer/ai/ChipBar.tsx`                | hover 浮卡 `max-h-40` 换 ScrollArea                                                                  | 改   |

**排除**（DD-6）：`Composer.tsx`（原生 `<textarea>` 内部滚动）、`select.tsx`（Base UI Select 自管弹层）——不动。

---

## Task 1: 新增 `scroll-area.tsx` 包装组件

**Files:**

- Create: `src/renderer/components/ui/scroll-area.tsx`

- [ ] **Step 1: 写组件**

`src/renderer/components/ui/scroll-area.tsx`：

```tsx
"use client";

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@renderer/lib/utils";

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** 透传给 Viewport（滚动元素）。max-height 等限高场景传这里（如 `max-h-40`）。 */
  viewportClassName?: string;
  /** 透传给 Viewport DOM 的 ref，供程序化滚动（如 AIPanel 滚底）。 */
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn("size-full", viewportClassName)}
      >
        <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none select-none opacity-0 transition-opacity duration-300 data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[scrolling]:duration-0",
        orientation === "vertical" && "h-full w-2.5 justify-center",
        orientation === "horizontal" && "h-2.5 w-full flex-col items-center",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "rounded-full bg-foreground/35",
          orientation === "vertical" ? "w-1.5" : "h-1.5",
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
```

> 说明：
>
> - 默认只渲染竖向 `ScrollBar`（DD-1 仅竖向）。
> - `Content` 不可省——Base UI 靠 Viewport vs Content 尺寸差测溢出。children 自动进 Content，消费方无需关心。
> - 限高场景（`max-h-*`）把限高类传 `viewportClassName`，靠 `max-height` + Viewport 内部 overflow 触发滚动（`size-full` 的 `h-full` 在 auto 高度的 Root 下退化为 auto，与 `max-h` 不冲突）。
> - `data-[hovering]`/`data-[scrolling]` 是 Base UI 在 Scrollbar 上的布尔属性，Tailwind v4 `data-[hovering]:` 匹配 `&[data-hovering]`。

- [ ] **Step 2: 类型与 lint 门**

Run: `pnpm typecheck && pnpm lint`
Expected: 均 PASS。

> 若 typecheck 报 `ScrollAreaPrimitive.Root.Props` 或 `.Scrollbar.Props` 不存在：打开 `node_modules/@base-ui/react/scroll-area` 的 `.d.ts` 确认命名空间类型导出名（Base UI 各 part 以 `<Part>.Props` 形式导出，与 `popover.tsx` 的 `PopoverPrimitive.Root.Props` 同构）；若 Thumb/Content/Corner 部件名不同，按 `.d.ts` 实际导出名修正。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/ui/scroll-area.tsx
git commit -m "feat(ui): add macOS-style ScrollArea wrapper over Base UI"
```

---

## Task 2: 阅读区彻底隐条（VirtualDocs `className` 透传 + EpubReader）

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`（接口加 `className?`、Virtuoso 接 `className`）
- Modify: `src/renderer/reader/EpubReader.tsx:208`（传 `className="no-scrollbar"`）

- [ ] **Step 1: VirtualDocs 接口加 `className?`**

在 `packages/virtual-docs/src/VirtualDocs.tsx` 的 `VirtualDocsProps`（第 12-31 行）末尾、`onContentMouseDown?` 之后加：

```tsx
  onContentMouseDown?: () => void;
  /** 透传给底层 Virtuoso 的 scroller 根元素的 className（如隐藏原生滚动条）。 */
  className?: string;
```

- [ ] **Step 2: 解构并传给 Virtuoso**

在 `VirtualDocs` 函数的 props 解构（第 34-45 行）里，于 `onContentMouseDown,` 后加 `className,`；并把 `<Virtuoso>`（第 86 行）改为接 `className`：

```tsx
<Virtuoso
  ref={vRef}
  className={className}
  style={{ height: "100%" }}
  totalCount={count}
  initialTopMostItemIndex={initialIndex ?? 0}
  itemContent={itemContent}
  rangeChanged={({ startIndex }) => onTopIndexChange?.(startIndex)}
/>
```

> Virtuoso 把 `className` 应用到其 scroller 根（滚动）元素，故 `no-scrollbar` 隐藏的正是阅读区那条原生条。

- [ ] **Step 3: EpubReader 传 `no-scrollbar`**

`src/renderer/reader/EpubReader.tsx` 第 208-226 行的 `<VirtualDocs ... />`，在 `ref={vRef}` 后加一行 `className="no-scrollbar"`：

```tsx
      <VirtualDocs
        ref={vRef}
        className="no-scrollbar"
        count={book.count}
        loadSection={book.loadSection}
```

> `.no-scrollbar` 是 `src/index.css:259` 既有全局类（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`），直接复用。

- [ ] **Step 4: 类型与 lint 门**

Run: `pnpm typecheck && pnpm lint`
Expected: 均 PASS。

> 工作区源码包改动后若运行时疑似未生效，参照记忆 `vite-optimizedeps-stale-workspace-pkg`：清 `.vite/deps`。本任务仅手测时留意。

- [ ] **Step 5: 提交**

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): hide native scrollbar in the reading viewport"
```

---

## Task 3: ChapterList 换 ScrollArea

**Files:**

- Modify: `src/renderer/reader/ChapterList.tsx`

- [ ] **Step 1: 引入并重构**

第 3 行 import 区加：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

把第 16-48 行的 `return (<nav className="flex h-full flex-col gap-0.5 overflow-y-auto p-2 font-sans"> … </nav>)` 改为用 `ScrollArea` 包裹、`nav` 去掉 `h-full overflow-y-auto`：

```tsx
return (
  <ScrollArea className="h-full">
    <nav className="flex flex-col gap-0.5 p-2 font-sans">
      {chapters.isPending && (
        <p className="p-2 text-sm text-muted-foreground">{t("reader.toc.loading", "加载目录…")}</p>
      )}
      {chapters.isError && (
        <p className="p-2 text-sm text-destructive">{t("reader.toc.loadError", "目录读取失败")}</p>
      )}
      {chapters.data?.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">
          {t("reader.toc.empty", "（本书无目录章节）")}
        </p>
      )}
      {chapters.data?.map((ch) => (
        <button
          key={ch.id}
          onClick={() => setCurrentChapter(ch.id)}
          style={{ paddingLeft: `${0.5 + ch.level * 0.875}rem` }}
          className={cn(
            "shrink-0 truncate rounded-md py-1.5 pe-2 text-start transition-colors",
            ch.level === 0 ? "text-sm" : "text-xs",
            ch.id === currentChapterId
              ? "bg-primary/10 font-medium text-primary"
              : ch.level === 0
                ? "text-foreground/80 hover:bg-muted"
                : "text-muted-foreground hover:bg-muted",
          )}
        >
          {ch.title ?? t("reader.toc.chapterFallback", "第 {{n}} 章", { n: ch.orderIndex + 1 })}
        </button>
      ))}
    </nav>
  </ScrollArea>
);
```

- [ ] **Step 2: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/reader/ChapterList.tsx
git commit -m "feat(reader): TOC sidebar uses ScrollArea"
```

---

## Task 4: AnnotationsList 换 ScrollArea

**Files:**

- Modify: `src/renderer/reader/AnnotationsList.tsx`

- [ ] **Step 1: 引入并重构**

import 区（第 8 行 Button 旁）加：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

把第 73-85 行的 `return (<div className="h-full space-y-1.5 overflow-y-auto p-2"> … </div>)` 改为：

```tsx
return (
  <ScrollArea className="h-full">
    <div className="space-y-1.5 p-2">
      {sorted.map((a) => (
        <AnnoItem
          key={a.id}
          a={a}
          chapter={chapterTitle(a.cfiRange)}
          onGoto={() => requestScroll(a.cfiRange)}
          onDelete={() => deleteM.mutate({ id: a.id })}
        />
      ))}
    </div>
  </ScrollArea>
);
```

> 注意 `AnnotationsList` 的 pending/error/empty 早返回分支（第 39-57 行）不变；只改最终列表 return。

- [ ] **Step 2: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/reader/AnnotationsList.tsx
git commit -m "feat(reader): annotations sidebar uses ScrollArea"
```

---

## Task 5: LibraryView 换 ScrollArea

**Files:**

- Modify: `src/renderer/library/LibraryView.tsx`

- [ ] **Step 1: 引入**

在 LibraryView 的 import 区加（与其余 `@renderer/components/ui/*` import 同处）：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

- [ ] **Step 2: 重构 `<main>`**

把第 142-168 行的 `<main className="flex-1 overflow-y-auto p-6"> … </main>` 改为：`ScrollArea` 作 flex 子项（承 `flex-1`），`<main>` 作内容（承 `p-6`、去 `flex-1 overflow-y-auto`）：

```tsx
<ScrollArea className="flex-1">
  <main className="p-6">
    {books.isPending && (
      <p className="text-sm text-muted-foreground">{t("library.loading", "加载书库…")}</p>
    )}
    {books.isError && (
      <p className="text-sm text-destructive">{t("library.loadError", "读取书库失败")}</p>
    )}
    {books.data?.length === 0 && (
      <div className="mt-20 text-center text-muted-foreground">
        <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
        <p className="text-sm">
          {t("library.empty", "书库为空，点右上角「导入 ePub」或把 .epub 拖进窗口开始。")}
        </p>
      </div>
    )}
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-5">
      {books.data?.map((b) => (
        <li key={b.id}>
          <BookCover book={b} onOpen={() => openBook(b.id)} onDelete={() => deleteBook.mutate(b)} />
        </li>
      ))}
    </ul>
  </main>
</ScrollArea>
```

> 父列容器须为 `flex flex-col` 且高度有界（header `shrink-0` + 此处 `flex-1`），原本即如此，故 Viewport 有界、可滚。

- [ ] **Step 3: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/library/LibraryView.tsx
git commit -m "feat(library): library grid uses ScrollArea"
```

---

## Task 6: AIPanel 换 ScrollArea（保自动滚底）

**Files:**

- Modify: `src/renderer/ai/AIPanel.tsx`

- [ ] **Step 1: 引入**

第 5 行 Button import 旁加：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

- [ ] **Step 2: 重构滚动区，`scrollRef` 接 Viewport**

把第 60-62 行的 `<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4"> <MessageList … /> </div>` 改为：

```tsx
<ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
  <div className="p-4">
    <MessageList messages={messages} status={status} />
  </div>
</ScrollArea>
```

> `scrollRef`（第 21 行 `useRef<HTMLDivElement | null>`）现指向 Viewport（真正的滚动元素），第 23-26 行的自动滚底 effect `el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })` **不变**。`min-h-0 flex-1` 移到 Root，保证 flex 子项可收缩并内部滚动。

- [ ] **Step 3: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/ai/AIPanel.tsx
git commit -m "feat(ai): chat message list uses ScrollArea, keep autoscroll"
```

---

## Task 7: SettingsShell 两处换 ScrollArea（关闭按钮提为固定）

**Files:**

- Modify: `src/renderer/settings/SettingsShell.tsx`

- [ ] **Step 1: 引入**

第 6 行 Button import 旁加：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

- [ ] **Step 2: 左侧 nav 换 ScrollArea**

把第 39-56 行的 `<nav className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border p-3"> … </nav>` 改为：ScrollArea 承外形（`w-48 shrink-0 border-e border-border`），内层 nav 承布局（`flex flex-col gap-1 p-3`）：

```tsx
<ScrollArea className="w-48 shrink-0 border-e border-border">
  <nav className="flex flex-col gap-1 p-3">
    <div className="mb-2 px-2 font-serif text-base font-semibold">
      {t("settings.title", "设置")}
    </div>
    {CATEGORIES.map((c) => (
      <button
        key={c.key}
        type="button"
        onClick={() => setActive(c.key)}
        className={cn(
          "rounded-md px-3 py-1.5 text-start text-sm",
          active === c.key ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
      >
        {c.label}
      </button>
    ))}
  </nav>
</ScrollArea>
```

- [ ] **Step 3: 右侧内容面板换 ScrollArea，关闭按钮提为固定**

把第 57-72 行的内容面板 `<div className="relative min-w-0 flex-1 overflow-y-auto p-6"> <Button .../> <div className="mx-auto max-w-2xl"> … </div> </div>` 改为：外层保持定位上下文承固定关闭按钮，滚动内容包进 ScrollArea（`p-6` 下移到内容包裹层）：

```tsx
<div className="relative min-w-0 flex-1">
  <Button
    variant="ghost"
    size="icon"
    onClick={() => setOpen(false)}
    className="absolute end-4 top-4 z-10"
    aria-label={t("settings.close", "关闭设置")}
  >
    <X />
  </Button>
  <ScrollArea className="h-full">
    <div className="mx-auto max-w-2xl p-6">
      {active === "models" && <ModelsSettings />}
      {active === "appearance" && <AppearanceSettings />}
      {active === "reading" && <ReadingSettings />}
    </div>
  </ScrollArea>
</div>
```

> 行为微调（更优）：关闭按钮从「随内容滚动」变为「固定悬浮」——它移出 ScrollArea、绝对定位于面板 Root（加 `z-10` 压在内容上）。这是有意改进，手测确认按钮始终可见、不遮挡标题。

- [ ] **Step 4: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/settings/SettingsShell.tsx
git commit -m "feat(settings): settings nav + content use ScrollArea, pin close button"
```

---

## Task 8: BookCard 摘要卡换 ScrollArea（max-h-96）

**Files:**

- Modify: `src/renderer/reader/BookCard.tsx`

- [ ] **Step 1: 引入**

在 BookCard 的 import 区加（与其余 `@renderer/components/ui/*` import 同处，如 Button 旁）：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

- [ ] **Step 2: 重构限高内容区**

把第 116-125 行的 `<div className="max-h-96 overflow-y-auto text-sm leading-relaxed text-foreground"> {text ? … : …} </div>` 改为：限高传 `viewportClassName`，内层保留文本样式：

```tsx
<ScrollArea viewportClassName="max-h-96">
  <div className="text-sm leading-relaxed text-foreground">
    {text ? (
      <Streamdown>{text}</Streamdown>
    ) : (
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{PLACEHOLDER[status]}</p>
    )}
  </div>
</ScrollArea>
```

> 限高场景把 `max-h-96` 给 Viewport（`viewportClassName`）而非 Root：`max-height` + Viewport 内部 overflow 在内容超高时触发滚动。

- [ ] **Step 3: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/reader/BookCard.tsx
git commit -m "feat(reader): book summary card uses ScrollArea"
```

---

## Task 9: ChipBar hover 浮卡换 ScrollArea（max-h-40）

**Files:**

- Modify: `src/renderer/ai/ChipBar.tsx`

- [ ] **Step 1: 引入**

第 6 行 import 区加：

```tsx
import { ScrollArea } from "@renderer/components/ui/scroll-area";
```

- [ ] **Step 2: 重构 ChipPopover 的滚动**

把第 84-101 行 `createPortal` 内的 `<div … className="max-h-40 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed shadow-xl"> … </div>` 改为：外层固定定位 + 外形（去 `max-h-40 overflow-y-auto p-3`），滚动内容包进 ScrollArea（`max-h-40` 给 Viewport、`p-3` 移到内容）：

```tsx
return createPortal(
  <div
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
    style={{ position: "fixed", left, bottom, zIndex: 60 }}
    className="w-80 rounded-lg border border-border bg-popover text-xs leading-relaxed shadow-xl"
  >
    <ScrollArea viewportClassName="max-h-40">
      <div className="p-3">
        <div className="mb-1 font-medium text-foreground">
          {t("ai.chip.willSend", "将发送")} · {label}
        </div>
        <p className="whitespace-pre-wrap text-muted-foreground">{chip.content}</p>
        {chip.required && (
          <div className="mt-2 text-[11px] text-muted-foreground/70">
            {t("ai.chip.requiredContext", "必备上下文，随消息一并发送。")}
          </div>
        )}
      </div>
    </ScrollArea>
  </div>,
  document.body,
);
```

- [ ] **Step 3: 门 + 提交**

Run: `pnpm typecheck && pnpm lint`（PASS）

```bash
git add src/renderer/ai/ChipBar.tsx
git commit -m "feat(ai): chip preview popover uses ScrollArea"
```

---

## Task 10: 手动验收（人工，`pnpm start`）

> **此任务不可由 subagent 完成**（需 GUI）。由用户/主会话运行 `pnpm start`，逐项核对；发现问题回到对应 Task 修。

**Files:** 无（仅验收）

- [ ] **Step 1: 启动**

Run: `pnpm start`（阻塞；导入一本含封面/多章/长正文的真书）

- [ ] **Step 2: 阅读区**
  - 滚动正文，全程**无任何滚动条**（原生消失、无 thumb）✓

- [ ] **Step 3: 7 处外壳容器逐项**（侧栏目录 / 侧栏标注 / 书库网格 / AI 消息流 / 设置左 nav / 设置内容面板 / 章节摘要卡 / Chip hover 浮卡）
  - 原生条消失 ✓
  - 内容溢出时 thumb 现；不溢出时无 thumb ✓
  - 滚动或悬停时 thumb 淡入、停手后淡出 ✓
  - thumb 可鼠标拖拽滚动，且拖拽期不选中页面文本 ✓
  - 暗色模式下 thumb（`bg-foreground/35`）对比可见 ✓
  - 无布局回归：高度/flex/padding 正确，内容不被裁切或错位 ✓

- [ ] **Step 4: 专项**
  - AIPanel：发新消息后仍平滑自动滚到底部 ✓
  - 设置内容面板：关闭按钮固定悬浮、滚动时始终可见、不遮标题 ✓
  - 设置左 nav / 标注列表：内容超高可滚 ✓

- [ ] **Step 5: 若 Base UI 变体未生效**（thumb 不淡入/常显）

参照记忆 `shadcn-base-ui-setup` 的 tabs `data-orientation` 错配坑：用 DevTools 查 Scrollbar 元素实际 data 属性名（`data-hovering`/`data-scrolling` 还是别的），若不符，在 `src/index.css` 的 `@custom-variant dark (...)` 旁补映射变体，或把 `scroll-area.tsx` 的 `data-[hovering]:`/`data-[scrolling]:` 改为实测属性名。修后回 Task 1 重验。

- [ ] **Step 6: 收尾**

全部 ✓ 后，用 **superpowers:finishing-a-development-branch** 技能决定合并方式，并在该流程里更新 `docs/superpowers/ROADMAP.md`（勾掉「移除阅读区原生滚动条」「类 macOS 自绘滚动条」两条，更新当前焦点）。

---

## 自检（计划 vs spec）

- **spec 覆盖**：DD-1 阅读区无条 → Task 2；DD-2 Base UI 原语 → Task 1；DD-3 可拖拽（Base UI 原生）→ Task 1 + Task 10 验；DD-4 macOS 审美 → Task 1 样式；DD-5 新组件仿 popover → Task 1；DD-6 7 处消费方/排除 → Tasks 3-9 + 文件结构表。§2（CSS 工具）→ 复用现有 `.no-scrollbar`（DRY 修正，已注明）。全覆盖。
- **占位符**：无 TBD/TODO；每个代码步含完整代码与确切命令。
- **类型一致**：`ScrollArea`/`ScrollBar` 导出名、`viewportClassName`/`viewportRef` prop 名在 Task 1 定义、Tasks 5/6/8/9 使用一致；`scrollRef` 类型 `HTMLDivElement` 与 `viewportRef` 匹配。
- **已知风险**：Base UI `Root.Props`/`Scrollbar.Props` 类型名、`Content`/`Corner` 部件名、`data-hovering`/`data-scrolling` 变体名——Task 1 Step 2 与 Task 10 Step 5 均有兜底排障指引。
