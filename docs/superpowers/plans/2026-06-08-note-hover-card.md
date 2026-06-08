# Note Hover Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 悬停带笔记的高亮（ePub / PDF）时弹出可移入的卡片，显示引文 + 笔记，并提供「编辑」入口跳转 NoteModal。

**Architecture:** 各 reader 做「命中适配」（ePub 在 iframe `mousemove` 里 `closest("mark.anno-noted")`，PDF 在容器 `onMouseMove` 里 `hitHighlight` 命中 `hasNote`）→ 上报到共享的 `note-hover-store`（zustand，内部用纯 reducer `note-hover-machine` + 一个关闭定时器实现「可移入」安全 hover）→ 单一 `<NoteHoverCard/>`（受控 Base UI PreviewCard + 虚拟锚点）按 annoId 从 React Query 缓存查 note 渲染。

> **对 spec 的精化**：spec §4.1/§6 写的是 `use-note-hover-card` hook，本计划改用 **zustand store**（`note-hover-store`）。理由：状态需跨 `EpubReader` / `PdfPage` / `NoteHoverCard` 三处独立组件共享，store 免去 props 穿透 `PdfReader→PdfPage`、并对齐既有 `annotation-store` 浮层模式（`SelectionToolbar`/`HighlightStyleBar`/`NoteModal` 均读它）。核心安全逻辑仍是纯 reducer 单测，满足 spec §4.1「抽纯函数可单测」的要求。

**Tech Stack:** React 19（启用 React Compiler——勿手写 useMemo/useCallback）+ zustand + `@base-ui/react` PreviewCard + react-i18next + vitest（node 环境，纯函数单测）。

---

## 关键既有事实（实现时依赖，勿臆测）

- `AnnotationDto`（`src/shared/annotations.ts:7`）：`{ id, bookId, style, note, selectedText, locatorRange, createdAt, updatedAt }`，`note` 必有（可空串）。
- 笔记数据缓存：`qk.annotations(bookId)`（`src/renderer/query/keys.ts:8`），`window.api.annotations.listByBook({ bookId })`。
- 编辑入口：`useAnnotationStore().openNoteModal({ target: { type: "edit", annotationId } })`（`src/renderer/store/annotation-store.ts:30`、`AnnoTarget` `:4`）。
- ePub 高亮 mark：`<mark class="anno anno-{style}[ anno-noted]" data-anno-id="{id}">`（`apply-annotations.ts:40-42,67`）；带笔记者有 `.anno-noted`。
- ePub 跨 iframe 坐标：`toViewportRect(el.getBoundingClientRect(), iframe.getBoundingClientRect())`（`packages/virtual-docs/src/geometry.ts:10`，返回 `{x,y,width,height}`）。
- PDF 命中：`hitHighlight(highlights, x, y)`（`use-pdf-highlights.ts:19`），`HighlightRect = { annoId, style, hasNote, rect: {left,top,width,height} }`；视口坐标 = `rect.left + base.x`（`base = textLayer.getBoundingClientRect()`，见 `PdfReader.tsx:395-403`）。
- Base UI PreviewCard 受控：`PreviewCard.Root` 有 `open` / `onOpenChange`；`PreviewCard.Positioner` 继承 `anchor?: Element | VirtualElement | RefObject | (() => …)` 与 `positionMethod?: 'absolute' | 'fixed'`（`node_modules/@base-ui/react/utils/useAnchorPositioning.d.ts:75,80`）。Trigger 可选，受控 `open` + 显式 `anchor` 即可，无需真实 trigger。
- 复用样式：引文 blockquote（`NoteModal.tsx:101`）、note 列表项（`AnnotationsList.tsx:122-124`）。

---

## Task 1: note-hover-machine 纯 reducer（TDD）

**Files:**

- Create: `src/renderer/reader/note-hover-machine.ts`
- Test: `src/renderer/reader/note-hover-machine.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/reader/note-hover-machine.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { reduceHover, HOVER_INITIAL, type HoverState } from "./note-hover-machine";

const RECT = { x: 10, y: 20, width: 100, height: 16 };
const RECT2 = { x: 10, y: 40, width: 80, height: 16 };

describe("reduceHover", () => {
  it("enterHighlight from idle opens and cancels any close timer", () => {
    const r = reduceHover(HOVER_INITIAL, { type: "enterHighlight", annoId: "a1", rect: RECT });
    expect(r.next).toEqual({ annoId: "a1", anchorRect: RECT, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("enterHighlight with same id while open is idempotent (keeps open, updates rect, cancels)", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterHighlight", annoId: "a1", rect: RECT2 });
    expect(r.next).toEqual({ annoId: "a1", anchorRect: RECT2, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("enterHighlight with different id while open switches to new id", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterHighlight", annoId: "a2", rect: RECT2 });
    expect(r.next).toEqual({ annoId: "a2", anchorRect: RECT2, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("leaveHighlight starts the close timer without changing state yet", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "leaveHighlight" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("start");
  });

  it("enterCard cancels the close timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterCard" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("cancel");
  });

  it("leaveCard starts the close timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "leaveCard" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("start");
  });

  it("closeNow resets to initial and cancels timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "closeNow" });
    expect(r.next).toEqual(HOVER_INITIAL);
    expect(r.timer).toBe("cancel");
  });

  it("multi-fragment: leaveHighlight then enterHighlight same id stays open (no flicker)", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const afterLeave = reduceHover(open, { type: "leaveHighlight" }).next; // timer running, state unchanged
    const afterReenter = reduceHover(afterLeave, {
      type: "enterHighlight",
      annoId: "a1",
      rect: RECT2,
    });
    expect(afterReenter.next.open).toBe(true);
    expect(afterReenter.next.annoId).toBe("a1");
    expect(afterReenter.timer).toBe("cancel");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/reader/note-hover-machine.test.ts`
Expected: FAIL —— `Failed to resolve import "./note-hover-machine"` / `reduceHover is not exported`。

- [ ] **Step 3: 实现 reducer**

Create `src/renderer/reader/note-hover-machine.ts`：

```ts
/** 锚点视口坐标矩形（与 virtual-docs ViewportRect、SelectionInfo.rect 同形状，故跨层结构兼容）。 */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HoverState {
  /** 当前命中的标注 id；无命中为 null。 */
  annoId: string | null;
  /** 卡片定位锚点（视口坐标）。 */
  anchorRect: AnchorRect | null;
  /** 卡片是否展开。 */
  open: boolean;
}

/** 给消费方（store）的定时器指令：start＝起关闭窗口，cancel＝撤销待关，none＝不动。 */
export type TimerCmd = "start" | "cancel" | "none";

export type HoverEvent =
  | { type: "enterHighlight"; annoId: string; rect: AnchorRect }
  | { type: "leaveHighlight" }
  | { type: "enterCard" }
  | { type: "leaveCard" }
  | { type: "closeNow" };

export const HOVER_INITIAL: HoverState = { annoId: null, anchorRect: null, open: false };

export interface HoverResult {
  next: HoverState;
  timer: TimerCmd;
}

/**
 * 安全 hover 状态机（纯函数）。副作用（真实 setTimeout）由 store 按 `timer` 指令执行。
 * 「可移入」靠 leave→start（150ms 窗口）、enter(card/highlight)→cancel 协调。
 */
export function reduceHover(state: HoverState, event: HoverEvent): HoverResult {
  switch (event.type) {
    case "enterHighlight": {
      // 幂等：同 id 已展开时不重置 open（仅更新锚点，跟随当前片段），避免多片段间闪烁。
      if (state.open && state.annoId === event.annoId) {
        return { next: { ...state, anchorRect: event.rect }, timer: "cancel" };
      }
      return {
        next: { annoId: event.annoId, anchorRect: event.rect, open: true },
        timer: "cancel",
      };
    }
    case "leaveHighlight":
      // 离开高亮：起关闭窗口（给鼠标移到卡片的时间），状态暂不变。
      return { next: state, timer: "start" };
    case "enterCard":
      return { next: state, timer: "cancel" };
    case "leaveCard":
      return { next: state, timer: "start" };
    case "closeNow":
      return { next: HOVER_INITIAL, timer: "cancel" };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/reader/note-hover-machine.test.ts`
Expected: PASS（8 passed）。

- [ ] **Step 5: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/reader/note-hover-machine.ts src/renderer/reader/note-hover-machine.test.ts
git commit -m "feat(reader): add note-hover safe-hover state machine (#58)"
```

---

## Task 2: note-hover-store（zustand，包定时器）

**Files:**

- Create: `src/renderer/store/note-hover-store.ts`

- [ ] **Step 1: 实现 store**

Create `src/renderer/store/note-hover-store.ts`：

```ts
import { create } from "zustand";
import {
  reduceHover,
  HOVER_INITIAL,
  type HoverState,
  type HoverEvent,
  type AnchorRect,
} from "@renderer/reader/note-hover-machine";

/** 离开高亮/卡片后关闭的宽限窗口（ms），对齐 hover-card.tsx 现有 closeDelay。 */
const CLOSE_DELAY_MS = 150;

interface NoteHoverActions {
  /** 命中适配上报：悬停到带笔记的高亮。 */
  hoverHighlight: (annoId: string, rect: AnchorRect) => void;
  /** 命中适配上报：离开高亮。 */
  leaveHighlight: () => void;
  /** 卡片自身：鼠标移入（取消待关）。 */
  enterCard: () => void;
  /** 卡片自身：鼠标移出（起待关）。 */
  leaveCard: () => void;
  /** 立即关闭（滚动 / 点编辑 / Esc / 点外部）。 */
  closeNow: () => void;
}

// 模块级单定时器：store 是单例，关闭窗口全局唯一。
let closeTimer: ReturnType<typeof setTimeout> | null = null;
function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export const useNoteHoverStore = create<HoverState & NoteHoverActions>((set, get) => {
  const dispatch = (event: HoverEvent) => {
    const { next, timer } = reduceHover(
      { annoId: get().annoId, anchorRect: get().anchorRect, open: get().open },
      event,
    );
    set(next);
    if (timer === "cancel") {
      clearCloseTimer();
    } else if (timer === "start") {
      clearCloseTimer();
      closeTimer = setTimeout(() => {
        closeTimer = null;
        set(HOVER_INITIAL);
      }, CLOSE_DELAY_MS);
    }
  };
  return {
    ...HOVER_INITIAL,
    hoverHighlight: (annoId, rect) => dispatch({ type: "enterHighlight", annoId, rect }),
    leaveHighlight: () => dispatch({ type: "leaveHighlight" }),
    enterCard: () => dispatch({ type: "enterCard" }),
    leaveCard: () => dispatch({ type: "leaveCard" }),
    closeNow: () => {
      clearCloseTimer();
      set(HOVER_INITIAL);
    },
  };
});
```

- [ ] **Step 2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/store/note-hover-store.ts
git commit -m "feat(reader): add note-hover-store driving the hover card (#58)"
```

---

## Task 3: 扩展 hover-card.tsx 支持虚拟锚点 + 定位方式

**Files:**

- Modify: `src/renderer/components/ui/hover-card.tsx:25-54`

- [ ] **Step 1: 给 HoverCardContent 增 anchor / positionMethod 透传**

把 `HoverCardContent`（`src/renderer/components/ui/hover-card.tsx:25`）整体替换为：

```tsx
function HoverCardContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "top",
  sideOffset = 6,
  anchor,
  positionMethod,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor" | "positionMethod"
  >) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        positionMethod={positionMethod}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "w-80 origin-(--transform-origin) rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-xl outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}
```

（仅新增 `anchor` / `positionMethod` 两个 props 并透传给 `Positioner`；其余不变，不影响现有 trigger 式用法。）

- [ ] **Step 2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/components/ui/hover-card.tsx
git commit -m "feat(ui): let HoverCardContent accept a virtual anchor (#58)"
```

---

## Task 4: NoteHoverCard 组件 + i18n + 挂载 ReaderView

**Files:**

- Create: `src/renderer/reader/NoteHoverCard.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx:31`（import）、`:234`（挂载）
- i18n: `pnpm i18n:extract` 收 `reader.note.edit`

- [ ] **Step 1: 实现 NoteHoverCard**

Create `src/renderer/reader/NoteHoverCard.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useNoteHoverStore } from "@renderer/store/note-hover-store";
import { HoverCard, HoverCardContent } from "@renderer/components/ui/hover-card";
import { Button } from "@renderer/components/ui/button";

/**
 * 悬停带笔记高亮时的卡片。受控开合由 note-hover-store 驱动；用虚拟锚点（视口坐标 +
 * positionMethod="fixed"）定位到命中的高亮矩形。卡片本身可移入（onMouseEnter/Leave →
 * store 取消/重起关闭窗口），便于读长笔记与点「编辑」。
 */
export function NoteHoverCard() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const annoId = useNoteHoverStore((s) => s.annoId);
  const anchorRect = useNoteHoverStore((s) => s.anchorRect);
  const open = useNoteHoverStore((s) => s.open);
  const enterCard = useNoteHoverStore((s) => s.enterCard);
  const leaveCard = useNoteHoverStore((s) => s.leaveCard);
  const closeNow = useNoteHoverStore((s) => s.closeNow);
  const openNoteModal = useAnnotationStore((s) => s.openNoteModal);

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });
  const anno = annoId ? annos.data?.find((a) => a.id === annoId) : undefined;

  // 虚拟锚点：把视口坐标 rect 包成 floating-ui VirtualElement（getBoundingClientRect 返回视口坐标）。
  const anchor = anchorRect
    ? {
        getBoundingClientRect: () => {
          const r = anchorRect;
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            top: r.y,
            left: r.x,
            right: r.x + r.width,
            bottom: r.y + r.height,
            toJSON() {},
          } as DOMRect;
        },
      }
    : undefined;

  if (!anno || !anchor) return null;

  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (!next) closeNow();
      }}
    >
      <HoverCardContent
        anchor={anchor}
        positionMethod="fixed"
        side="top"
        align="start"
        onMouseEnter={enterCard}
        onMouseLeave={leaveCard}
      >
        {anno.selectedText && (
          <blockquote className="line-clamp-2 border-s-2 border-border ps-3 font-serif text-sm italic leading-snug text-muted-foreground">
            {anno.selectedText}
          </blockquote>
        )}
        {anno.note && (
          <div className="no-scrollbar mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-popover-foreground">
            {anno.note}
          </div>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground"
            onClick={() => {
              const id = annoId;
              closeNow();
              if (id) openNoteModal({ target: { type: "edit", annotationId: id } });
            }}
          >
            <Pencil className="size-3.5" />
            {t("reader.note.edit", "编辑")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
```

- [ ] **Step 2: 挂到 ReaderView**

在 `src/renderer/reader/ReaderView.tsx` 的 import 区（`:31` `NoteModal` import 之后）加：

```tsx
import { NoteHoverCard } from "@renderer/reader/NoteHoverCard";
```

在 `:234` `<NoteModal />` 之后加一行：

```tsx
      <NoteModal />
      <NoteHoverCard />
```

- [ ] **Step 3: 提取 i18n key**

Run: `pnpm i18n:extract`
然后确认 `reader.note.edit` 已进 `src/renderer/locales/zh-CN/*.json`（值「编辑」），并按既有流程补 `en` 译文（如 `en` 被回填成中文 fallback，手动改回 `"Edit"`——见 memory「i18n 操作性坑」：extract 会用旧 fallback 反向覆盖，改完 `git diff` 核对仅 `reader.note.edit` 变动）。

- [ ] **Step 4: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/reader/NoteHoverCard.tsx src/renderer/reader/ReaderView.tsx src/renderer/locales
git commit -m "feat(reader): add NoteHoverCard, mount in ReaderView (#58)"
```

> 注：此时 store 无人喂事件，卡片不会出现——Task 5/6 接入命中适配后才生效。typecheck 绿即过。
>
> **方案 A 验证关卡**：Task 5 完成后的首次 ePub 冒烟即检验「受控 PreviewCard + 无真实 trigger + 虚拟锚点」是否成立。若卡片不渲染或定位错乱（Base UI 受控需配 trigger），退 spec §4.3 方案 B：把 `<HoverCard>/<HoverCardContent>` 换成一个自绘的 `position: fixed` 卡片（`left/top` 由 `anchorRect` 运行时计算，规范允许内联承载计算值），其余（store、命中适配、内容、可移入）全部不变。

---

## Task 5: ePub 命中适配（SectionFrame + VirtualDocs 透传 + EpubReader 接线）

**Files:**

- Modify: `packages/virtual-docs/src/SectionFrame.tsx`
- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`
- Modify: `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: SectionFrame 暴露 hover 回调**

在 `packages/virtual-docs/src/SectionFrame.tsx` 的 `Props`（`:12-30`）里，于 `onHighlightClick` 之后新增两个可选 prop：

```ts
  /** 悬停带笔记的高亮 mark（class 含 anno-noted）时回调；rect 为视口坐标。 */
  onHighlightHover?: (annoId: string, rect: ViewportRect) => void;
  /** 离开带笔记高亮（移到非 noted 区域 / 移出 iframe）时回调。 */
  onHighlightLeave?: () => void;
```

把这两个加入 `cbRef`（`:61-78` 的两个对象字面量都要加）：在 `onHighlightClick,` 后各加 `onHighlightHover,` 和 `onHighlightLeave,`。

在 `useEffect` 内（`:81` 起）新增一个「上次命中 id」局部变量与 hover 处理，并改造现有 `onContentMove`（`:139-143`）。把 `onContentMove` 整段替换为：

```ts
// 上次命中的带笔记高亮 id（仅在变化时上报，减少无谓 store 写入与重渲染）。
let lastNotedId: string | null = null;
const reportLeaveIfNeeded = () => {
  if (lastNotedId !== null) {
    lastNotedId = null;
    cbRef.current.onHighlightLeave?.();
  }
};
// 悬停在选区上 → 手型；并检测带笔记高亮 → 上报 hover/leave。
const onContentMove = (e: MouseEvent) => {
  if (!doc?.body) return;
  const cursor = pointInSelection(e.clientX, e.clientY) ? "pointer" : "";
  if (doc.body.style.cursor !== cursor) doc.body.style.cursor = cursor;
  const mark = (e.target as Element | null)?.closest?.("mark.anno-noted") as HTMLElement | null;
  const id = mark?.getAttribute("data-anno-id") ?? null;
  if (id === lastNotedId) return;
  lastNotedId = id;
  if (id && mark) {
    const r = mark.getBoundingClientRect();
    const fr = iframe.getBoundingClientRect();
    cbRef.current.onHighlightHover?.(id, toViewportRect(r, fr));
  } else {
    cbRef.current.onHighlightLeave?.();
  }
};
// 鼠标移出 iframe（含移向主文档的卡片）→ 上报 leave，起关闭窗口（移到卡片会被 enterCard 取消）。
const onContentOut = (e: MouseEvent) => {
  // relatedTarget 为 null = 离开 iframe 文档边界。
  if ((e as MouseEvent).relatedTarget === null) reportLeaveIfNeeded();
};
```

在 `onLoad`（`:166`）末尾、现有 `doc.addEventListener("mousemove", onContentMove);`（`:209`）之后追加：

```ts
doc.addEventListener("mouseout", onContentOut);
```

在 `detach`（`:144-165`）里，于 `doc?.removeEventListener("mousemove", onContentMove);`（`:161`）之后追加：

```ts
doc?.removeEventListener("mouseout", onContentOut);
```

`detach`、`onContentMove`/`onContentOut`/`reportLeaveIfNeeded`/`lastNotedId` 都在同一个 `useEffect` 作用域内，`detach` 可直接调用 `reportLeaveIfNeeded`（iframe 被 virtuoso 回收时补一次 leave，避免卡片悬空）。在 `detach` 内 `if (doc?.body) doc.body.style.cursor = "";`（`:162`）之后追加：

```ts
reportLeaveIfNeeded();
```

- [ ] **Step 2: VirtualDocs 透传两 prop**

在 `packages/virtual-docs/src/VirtualDocs.tsx`：

`VirtualDocsProps`（`:23-46`）于 `onHighlightClick` 后加：

```ts
  onHighlightHover?: (annoId: string, rect: ViewportRect) => void;
  onHighlightLeave?: () => void;
```

函数解构参数（`:48-63`）于 `onHighlightClick,` 后加 `onHighlightHover,`、`onHighlightLeave,`。

`LazySection` 的 props 类型（`:222-235`）与解构（`:208-221`）同样各加这两项（类型用上面相同签名）。

`itemContent`（`:150-181`）的 `<LazySection ... />` 调用里、`onHighlightClick={onHighlightClick}` 后加：

```tsx
onHighlightHover = { onHighlightHover };
onHighlightLeave = { onHighlightLeave };
```

并把这两项加入 `itemContent` 的 `useCallback` 依赖数组（`:168-180`），在 `onHighlightClick,` 后加 `onHighlightHover,`、`onHighlightLeave,`。

`LazySection` 内部把这两 prop 透传给 `<SectionFrame ... />`（`:265-277`），在 `onHighlightClick={onHighlightClick}` 后加：

```tsx
onHighlightHover = { onHighlightHover };
onHighlightLeave = { onHighlightLeave };
```

> 该包不过 React Compiler（见 `VirtualDocs.tsx:107` 注释），新 prop 全程跟随既有手动 `useCallback`/透传链即可——无需额外记忆化（值来自 EpubReader 的 zustand selector，引用稳定）。

- [ ] **Step 3: EpubReader 接线**

在 `src/renderer/reader/EpubReader.tsx`：

import 区（`:12` `useAnnotationStore` import 之后）加：

```ts
import { useNoteHoverStore } from "@renderer/store/note-hover-store";
```

组件内（`:51` `scrollCommand` 取值附近）加三个 selector：

```ts
const hoverHighlight = useNoteHoverStore((s) => s.hoverHighlight);
const leaveHighlight = useNoteHoverStore((s) => s.leaveHighlight);
const closeNoteHover = useNoteHoverStore((s) => s.closeNow);
```

在「滚动即放弃」effect（`:220-227`）的 `onScroll` 里追加关卡片，整段替换为：

```ts
useEffect(() => {
  const onScroll = () => {
    closeStyleBar();
    setSelection(null);
    closeNoteHover();
  };
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}, [closeStyleBar, setSelection, closeNoteHover]);
```

给 `<VirtualDocs>`（`:248-270`）在 `onHighlightClick={onHighlightClick}` 后加：

```tsx
onHighlightHover = { hoverHighlight };
onHighlightLeave = { leaveHighlight };
```

- [ ] **Step 4: typecheck + commit**

```bash
pnpm typecheck
git add packages/virtual-docs/src/SectionFrame.tsx packages/virtual-docs/src/VirtualDocs.tsx src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): wire ePub highlight hover to note hover card (#58)"
```

---

## Task 6: PDF 命中适配（PdfPage onMouseMove/Leave + PdfReader 滚动关）

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`

- [ ] **Step 1: import store**

在 `src/renderer/reader/PdfReader.tsx` import 区（`:24` `use-pdf-highlights` import 之后）加：

```ts
import { useNoteHoverStore } from "@renderer/store/note-hover-store";
```

- [ ] **Step 2: PdfReader 顶层滚动关卡片**

在 `PdfReader` 组件内（`:61` `closeStyleBar` 取值之后）加：

```ts
const closeNoteHover = useNoteHoverStore((s) => s.closeNow);
```

把「滚动即放弃」effect（`:211-218`）整段替换为：

```ts
useEffect(() => {
  const onScroll = () => {
    closeStyleBar();
    setSelection(null);
    closeNoteHover();
  };
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}, [closeStyleBar, setSelection, closeNoteHover]);
```

- [ ] **Step 3: PdfPage 命中带笔记高亮 → 上报 hover**

在 `PdfPage`（`:335`）内，于 `const openStyleBar = ...`（`:352`）之后加：

```ts
const hoverHighlight = useNoteHoverStore((s) => s.hoverHighlight);
const leaveHighlight = useNoteHoverStore((s) => s.leaveHighlight);
const lastNotedId = useRef<string | null>(null);
```

把现有 `onMouseMove`（`:413-423`）与 `onMouseLeave`（`:424`）整段替换为：

```ts
// hover 可点击目标（标注高亮 / 活跃选区）→ pointer cursor；命中带笔记高亮 → 弹卡片。
// overlay pointer-events-none 不接事件，统一在容器 mousemove 命中测试。
const onMouseMove = (e: ReactMouseEvent) => {
  const layer = textLayerRef.current;
  if (!layer) return;
  const base = layer.getBoundingClientRect();
  const hit =
    highlights.length > 0
      ? hitHighlight(highlights, e.clientX - base.x, e.clientY - base.y)
      : undefined;
  const over = pointInDomSelection(e.clientX, e.clientY) || hit !== undefined;
  if (over) layer.setAttribute("data-pointer", "");
  else layer.removeAttribute("data-pointer");

  const noted = hit?.hasNote ? hit : undefined;
  const id = noted?.annoId ?? null;
  if (id !== lastNotedId.current) {
    lastNotedId.current = id;
    if (noted) {
      hoverHighlight(noted.annoId, {
        x: noted.rect.left + base.x,
        y: noted.rect.top + base.y,
        width: noted.rect.width,
        height: noted.rect.height,
      });
    } else {
      leaveHighlight();
    }
  }
};
const onMouseLeave = () => {
  textLayerRef.current?.removeAttribute("data-pointer");
  if (lastNotedId.current !== null) {
    lastNotedId.current = null;
    leaveHighlight();
  }
};
```

> 行为等价校验：原逻辑 `over = pointInDomSelection(...); if (!over && highlights>0) over = hitHighlight(...) !== undefined;`，新写法先算 `hit` 再 `over = selection || hit`，对 `data-pointer` 的最终结果一致（命中高亮或选区即手型）。

- [ ] **Step 4: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/reader/PdfReader.tsx
git commit -m "feat(reader): wire PDF highlight hover to note hover card (#58)"
```

---

## Task 7: 收尾（全量校验 + 手动冒烟 + changeset）

**Files:**

- Create: `.changeset/<random-name>.md`

- [ ] **Step 1: 全量 typecheck / lint / test**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿；新测试 `note-hover-machine.test.ts` 在内。

- [ ] **Step 2: 手动冒烟（用户侧亦会测，但实现者先自查）**

`pnpm start`，分别在一本 ePub 与一本 PDF 上：

1. 给一段文字加高亮**并写笔记** → 悬停该高亮，卡片在高亮上方弹出，显示引文 + 笔记；
2. 鼠标从高亮移到卡片上 → 卡片**不消失**，可滚动读长笔记；
3. 点卡片「编辑」→ 卡片关闭，NoteModal 以该标注 edit 态打开；
4. 悬停一个**无笔记**的高亮 → **不**弹卡片；
5. 悬停时滚动页面 → 卡片关闭；
6. ePub 跨行高亮：在同一条标注的不同行之间移动 → 卡片不闪烁。

- [ ] **Step 3: changeset**

Run: `pnpm changeset`（patch；摘要英文）：

```
Add a hover card that previews a highlight's note in both the ePub and PDF readers. Hover an annotated selection to see its quote and note, move into the card to read long notes, and click Edit to jump straight to the note editor.
```

- [ ] **Step 4: commit changeset**

```bash
git add .changeset
git commit -m "docs: add changeset for note hover card (#58)"
```

---

## 完成定义

- `pnpm typecheck && pnpm lint && pnpm test` 全绿；
- ePub 与 PDF 均：悬停带笔记高亮弹卡片、可移入读长笔记、点编辑进 NoteModal、无笔记不弹、滚动即关；
- 分支 `feat/note-hover-card` 上每个 Task 一笔 commit + 一条 changeset；
- 交付后由 finishing-a-development-branch 决定合并方式，并把 #58 挪 Done（commit 含 `closes #58`，见 kanban 流程）。
