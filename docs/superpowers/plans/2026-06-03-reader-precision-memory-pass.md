# 阅读精度 / 长书内存 pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除真实阅读的三个体验债——① 向上滚动跳闪 / 图片加载跳变、② 长书 `section.document` 无限常驻内存、③ 当前章高亮 overscan 偏移。

**Architecture:** 方案 A——把三症状的**决策逻辑抽成纯函数**（`precision.ts`：`estimateHeight`/`sectionsToUnload`/`topVisibleIndex`，headless TDD）；DOM 接线落在 store-agnostic 的 `virtual-docs`（`SectionFrame` 就绪后一次性上报稳定高度 + 测高缓存；`VirtualDocs` 距离阈值 unload + IntersectionObserver 精确视口顶）与 `epub-book`（`unloadSection`）；`EpubReader` 仅消费新回调（调用点 / reader-store 结构不变，与 #10 正交）。

**Tech Stack:** TypeScript 6、React 19（启用 React Compiler，勿手写 useMemo/useCallback 除非命令式 effect 清理）、react-virtuoso 4、epubjs 0.3.93、Vitest 4（Electron 运行时）。

设计依据：`docs/superpowers/specs/2026-06-03-reader-precision-memory-pass-design.md`。

**已核事实（写计划时已验证）：**

- `epubjs/types/section.d.ts:59` 声明 `unload(): void`——直接调用，无需断言。`render` 仍是误标同步（现有代码 `epub-book.ts:73` 已 `as unknown as Promise<string>`）。
- react-virtuoso `rangeChanged?: (range: ListRange)` 的 `ListRange = { startIndex: number; endIndex: number }`；`scrollerRef?: (ref: HTMLElement | null | Window) => any` 拿滚动容器（IO root）。
- 现状：`VirtualDocs.tsx:92` 用 `rangeChanged={({startIndex}) => onTopIndexChange?.(startIndex)}`（含 overscan，故 ③ 滞后）；`LazySection`（`VirtualDocs.tsx:118-146`）html 未就绪时占位 `<div style={{ minHeight: 200 }} />`。
- `SectionFrame.tsx:133-150` 的 `onLoad`：`measure()` 立即设高度 + `ResizeObserver(measure)` 持续重测（这是 ① 加载中多次跳的源）。
- `epub-book.ts` 的 `EpubBook` 接口（`:8-27`）暂无 `unloadSection`；`sectionAt(index)`（`:54-61`）是内部 helper；`cfiAtIndex`/`cfiFromRange` 依赖 `s.document` 常驻（仅在可见 section 调用，故 unload 远离视口安全——见 spec「CFI 安全不变量」）。
- `EpubReader.tsx:119-139` 的 `onTopIndexChange` 同时驱动「当前章高亮 + 防抖存进度」；`:206-224` 挂 `VirtualDocs`。
- 测试模式：纯函数用 Vitest（`geometry.test.ts` 即范例，node 环境无 DOM）。`epub-book`/`SectionFrame`/`VirtualDocs` 无现有测试（依赖 epubjs/iframe/IO，难 headless）——故本计划**仅纯逻辑走 TDD，DOM 接线靠 typecheck + 末尾真书手测**（见末尾「手测验收清单」）。
- React Compiler 已启用：**不要手写** `useCallback`/`useMemo` 包装；但 effect 内命令式资源清理（IO/RO/timer disconnect）仍要手写。

---

## File Structure

| 文件                                                | 责任                                                                                                  | Task       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| `packages/virtual-docs/src/precision.ts`（新）      | 三个纯决策函数：`estimateHeight`/`sectionsToUnload`/`topVisibleIndex`                                 | T1         |
| `packages/virtual-docs/src/precision.test.ts`（新） | 上述纯函数的 headless 单测                                                                            | T1         |
| `src/renderer/reader/epub-book.ts`                  | `EpubBook.unloadSection(index)` = `section.unload()`                                                  | T2         |
| `packages/virtual-docs/src/SectionFrame.tsx`        | ① 就绪后一次性上报稳定高度 + `onMeasured` + 占位估高 + RO debounce                                    | T3         |
| `packages/virtual-docs/src/VirtualDocs.tsx`         | 测高缓存（①）；距离阈值 unload（②）；IO 精确视口顶（③）；`onUnloadSection`/`onTopSectionChange` props | T4, T5, T6 |
| `packages/virtual-docs/src/index.ts`                | 导出可能新增的公共类型（如需要）                                                                      | T6         |
| `src/renderer/reader/EpubReader.tsx`                | 消费 `onTopSectionChange`、转发 `onUnloadSection`                                                     | T7         |

---

## Task 1: 纯决策逻辑模块 `precision.ts`（TDD）

**Files:**

- Create: `packages/virtual-docs/src/precision.ts`
- Test: `packages/virtual-docs/src/precision.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/virtual-docs/src/precision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateHeight, sectionsToUnload, topVisibleIndex } from "./precision";

describe("estimateHeight", () => {
  it("returns cached height when present", () => {
    const cache = new Map([[3, 742]]);
    expect(estimateHeight(cache, 3, 600)).toBe(742);
  });
  it("falls back to the default estimate when uncached", () => {
    expect(estimateHeight(new Map(), 3, 600)).toBe(600);
  });
});

describe("sectionsToUnload", () => {
  it("keeps the active range plus keepDistance on both sides", () => {
    // total 20, range [8,10], keepDistance 2 → keep [6..12], unload rest
    const out = sectionsToUnload({ startIndex: 8, endIndex: 10 }, 20, 2);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 13, 14, 15, 16, 17, 18, 19]);
  });
  it("returns empty when the whole book is within keepDistance", () => {
    expect(sectionsToUnload({ startIndex: 0, endIndex: 4 }, 5, 2)).toEqual([]);
  });
  it("clamps at boundaries (no negative / out-of-range indices)", () => {
    expect(sectionsToUnload({ startIndex: 0, endIndex: 0 }, 4, 1)).toEqual([2, 3]);
  });
});

describe("topVisibleIndex", () => {
  const vt = 100; // viewport top line
  it("returns null for empty input", () => {
    expect(topVisibleIndex([], vt)).toBeNull();
  });
  it("picks the section straddling the viewport-top line", () => {
    const secs = [
      { index: 0, top: 0, bottom: 90 },
      { index: 1, top: 90, bottom: 300 }, // contains 100
      { index: 2, top: 300, bottom: 500 },
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
  it("on a gap, picks the nearest section below the line", () => {
    const secs = [
      { index: 0, top: 0, bottom: 80 },
      { index: 1, top: 120, bottom: 300 }, // first with top >= 100
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
  it("when all sections are above the line, picks the lowest (max bottom)", () => {
    const secs = [
      { index: 0, top: -200, bottom: -50 },
      { index: 1, top: -100, bottom: 20 }, // max bottom
    ];
    expect(topVisibleIndex(secs, vt)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/virtual-docs/src/precision.test.ts`
Expected: FAIL —— `Failed to resolve import "./precision"`（模块未建）。

- [ ] **Step 3: 写最小实现**

Create `packages/virtual-docs/src/precision.ts`:

```ts
/** 估高占位：缓存命中用缓存高度，否则用默认估值。 */
export function estimateHeight(
  cache: ReadonlyMap<number, number>,
  index: number,
  defaultEstimate: number,
): number {
  return cache.get(index) ?? defaultEstimate;
}

/**
 * 距 active range 超过 keepDistance 的 section 索引（应 unload 的集合）。
 * 保留区间 = [startIndex - keepDistance, endIndex + keepDistance]，区间外全部淘汰。
 */
export function sectionsToUnload(
  range: { startIndex: number; endIndex: number },
  total: number,
  keepDistance: number,
): number[] {
  const lo = range.startIndex - keepDistance;
  const hi = range.endIndex + keepDistance;
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (i < lo || i > hi) out.push(i);
  }
  return out;
}

/**
 * 给定各 section 在视口坐标的 top/bottom 与视口顶线 viewportTop，挑真实视口顶 section 的索引。
 * 规则：① 优先选「跨越视口顶线」者（top<=vt<bottom；多个取 top 最大、最贴线下方）；
 *       ② 间隙无命中时取 top>=vt 中 top 最小者（视口下方最近）；
 *       ③ 全在上方时取 bottom 最大者（最靠下）。空输入返回 null。
 */
export function topVisibleIndex(
  sections: ReadonlyArray<{ index: number; top: number; bottom: number }>,
  viewportTop: number,
): number | null {
  if (sections.length === 0) return null;
  const crossing = sections.filter((s) => s.top <= viewportTop && s.bottom > viewportTop);
  if (crossing.length > 0) {
    return crossing.reduce((a, b) => (b.top > a.top ? b : a)).index;
  }
  const below = sections.filter((s) => s.top >= viewportTop);
  if (below.length > 0) {
    return below.reduce((a, b) => (b.top < a.top ? b : a)).index;
  }
  return sections.reduce((a, b) => (b.bottom > a.bottom ? b : a)).index;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test packages/virtual-docs/src/precision.test.ts`
Expected: PASS（11 个用例全绿）。

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/virtual-docs/src/precision.ts packages/virtual-docs/src/precision.test.ts
git commit -m "feat(virtual-docs): add precision pure logic (estimateHeight/sectionsToUnload/topVisibleIndex)

阅读精度/内存 pass 的决策逻辑抽成纯函数，headless 单测覆盖。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `epub-book` 加 `unloadSection`（②）

**Files:**

- Modify: `src/renderer/reader/epub-book.ts`（接口 `:8-27`、实现 `:63-157`）

> 无 headless 测（依赖 epubjs + 真 ePub zip + DOM；现仓库 epub-book 即无测试）。靠 typecheck + Task 7 后真书手测验证。

- [ ] **Step 1: 接口加 `unloadSection`**

在 `EpubBook` 接口里（`destroy` 之前）加：

```ts
  /** 卸载第 index 个 section 的解析文档（释放内存）；幂等，未加载/越界为 no-op。仅对远离视口的 section 调用。 */
  unloadSection: (index: number) => void;
```

- [ ] **Step 2: 实现 `unloadSection`**

在 `createEpubBook` 返回对象里（`destroy` 之前）加：

```ts
    unloadSection: (index) => {
      const s = sectionAt(index);
      // s.document 未加载时 unload 为 no-op；epubjs Section.unload 已声明返回 void。
      if (s) s.unload();
    },
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 全绿（不应破坏任何现有测试）。

```bash
git add src/renderer/reader/epub-book.ts
git commit -m "feat(reader): add EpubBook.unloadSection to release section documents (#reader-precision)

为长书内存有界铺路：远离视口的 section 可 unload 释放 s.document，重进 loadSection 重渲。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `SectionFrame` ① 就绪后上报稳定高度 + 估高占位 + RO debounce

**Files:**

- Modify: `packages/virtual-docs/src/SectionFrame.tsx`（Props `:12-26`、cbRef `:50-57`、onLoad `:133-150`、iframe 渲染 `:165-174`）

> 无 headless 测（iframe + ResizeObserver + img.decode + fonts.ready 难在 node 环境复现）。靠 typecheck + 末尾真书手测。

- [ ] **Step 1: 顶部加常量**

在 `const STYLE_ID = "vd-style";`（`:28`）之后加：

```ts
/** 等待图片/字体就绪的整体超时（ms），到时即用当前高度兜底，绝不无限等。 */
const READY_TIMEOUT_MS = 2000;
/** 就绪后真实内容变化（如改字号偏好）重测的 debounce（ms）。 */
const RO_DEBOUNCE_MS = 100;
```

- [ ] **Step 2: Props 加 `estimatedHeight` / `onMeasured`**

在 `Props` 接口（`onContentMouseDown` 之后）加：

```ts
  /** 就绪前的占位高度（来自 VirtualDocs 测高缓存）；避免就绪前 0/默认高度造成跳变。 */
  estimatedHeight?: number;
  /** 内容就绪、测得稳定高度后回调（index, heightPx），供 VirtualDocs 写测高缓存。 */
  onMeasured?: (index: number, height: number) => void;
```

- [ ] **Step 3: 函数签名解构 + cbRef 纳入新回调**

把组件参数解构（`:37-47`）补上两个新 prop：

```ts
export function SectionFrame({
  index,
  html,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  decorateNonce,
  onContentMouseDown,
  estimatedHeight,
  onMeasured,
}: Props) {
```

把 cbRef 初始化（`:50-56`）与每渲染赋值（`:57`）补上 `estimatedHeight`/`onMeasured`：

```ts
const cbRef = useRef({
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  onContentMouseDown,
  estimatedHeight,
  onMeasured,
});
cbRef.current = {
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  onContentMouseDown,
  estimatedHeight,
  onMeasured,
};
```

- [ ] **Step 4: 重写 `onLoad`——就绪后一次性上报稳定高度**

把现有 `onLoad`（`:133-150`）整体替换为：

```ts
const onLoad = () => {
  detach();
  doc = iframe.contentDocument;
  if (!doc) return;
  const d = doc; // 窄化给闭包
  // 占位：就绪前先用估高，避免 iframe 默认高度造成的跳变。
  iframe.style.height = `${cbRef.current.estimatedHeight ?? 0}px`;

  const measure = () => {
    iframe.style.height = `${d.documentElement.scrollHeight}px`;
  };
  let settled = false;
  let roTimer: ReturnType<typeof setTimeout> | undefined;
  const reportStable = () => {
    if (settled) return;
    settled = true;
    measure();
    cbRef.current.onMeasured?.(index, d.documentElement.scrollHeight);
    // 就绪后才挂 ResizeObserver，服务后续真实内容变化（如改字号偏好），debounce 抑抖。
    ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(measure, RO_DEBOUNCE_MS);
    });
    ro.observe(d.documentElement);
  };

  // 等所有图片 decode + 字体就绪；整体超时兜底，绝不无限等。
  const imgs = Array.from(d.images);
  const ready = Promise.all([
    ...imgs.map((img) => img.decode().catch(() => undefined)),
    d.fonts?.ready ?? Promise.resolve(),
  ]).then(() => undefined);
  const timeout = new Promise<void>((res) => setTimeout(res, READY_TIMEOUT_MS));
  void Promise.race([ready, timeout]).then(reportStable);

  doc.addEventListener("mouseup", onMouseUp);
  doc.addEventListener("selectionchange", onSelChange);
  docRef.current = doc;
  cbRef.current.decorate?.(index, doc);
  doc.addEventListener("click", onAnnoClick);
  doc.addEventListener("mousedown", onContentDown);
  doc.addEventListener("mousemove", onContentMove);
};
```

（注：`detach()` 已 `ro?.disconnect()`，`ro` 在 reportStable 前为 `undefined` 时 disconnect 安全；`roTimer` 是 onLoad 局部，随 iframe 重载/卸载自然失效。）

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 全绿（无新增测试，确认未破坏现有）。

```bash
git add packages/virtual-docs/src/SectionFrame.tsx
git commit -m "feat(virtual-docs): SectionFrame reports stable height after images/fonts ready

根除图片加载→高度突变→向上滚跳：onLoad 等 img.decode()+fonts.ready（超时兜底）后
一次性测高并上报 onMeasured；就绪前用 estimatedHeight 占位；RO 改 debounce 仅服务就绪后变化。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `VirtualDocs` 测高缓存 + 占位用缓存（① 配套）

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`（import `:1-4`、itemContent `:59-83`、LazySection `:97-146`）

> 无 headless 测；靠 typecheck + 末尾真书手测。`estimateHeight` 纯逻辑已在 T1 测。

- [ ] **Step 1: import 纯逻辑 + 顶部常量**

把首行 import 后加入 precision import，并在 `VirtualDocsProps` 之前加默认估高常量：

```ts
import { estimateHeight } from "./precision";

/** 未缓存 section 的默认占位高度（px）；缓存命中后用真实测高。 */
const DEFAULT_ESTIMATE = 600;
```

- [ ] **Step 2: 组件内维护测高缓存 + prefs 失效**

在 `VirtualDocs` 函数体顶部（`vRef` 声明之后）加：

```ts
const heightCache = useRef<Map<number, number>>(new Map());
// styleCss（排版偏好/主题）变更会改变所有 section 高度 → 整体失效缓存。
useEffect(() => {
  heightCache.current.clear();
}, [styleCss]);
```

- [ ] **Step 3: itemContent 传 estimatedHeight + onMeasured**

把 `itemContent`（`:59-83`）替换为（透传估高与测得回调；React Compiler 下不手写 useCallback）：

```ts
  const onMeasured = (i: number, h: number) => {
    heightCache.current.set(i, h);
  };
  const itemContent = (index: number) => (
    <LazySection
      index={index}
      loadSection={loadSection}
      styleCss={styleCss}
      onSelect={onSelect}
      onSelectionCleared={onSelectionCleared}
      decorate={decorate}
      onHighlightClick={onHighlightClick}
      decorateNonce={decorateNonce}
      onContentMouseDown={onContentMouseDown}
      estimatedHeight={estimateHeight(heightCache.current, index, DEFAULT_ESTIMATE)}
      onMeasured={onMeasured}
    />
  );
```

并把 `<Virtuoso ... itemContent={itemContent} />` 保持不变（仍引用 `itemContent`）。

- [ ] **Step 4: LazySection 接收并使用占位估高**

把 `LazySection` 的参数列表与 props 类型补上 `estimatedHeight`/`onMeasured`，并把未就绪占位 `<div style={{ minHeight: 200 }} />`（`:132`）改为用估高：

```ts
function LazySection({
  index,
  loadSection,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  decorateNonce,
  onContentMouseDown,
  estimatedHeight,
  onMeasured,
}: {
  index: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  decorateNonce?: number;
  onContentMouseDown?: () => void;
  estimatedHeight?: number;
  onMeasured?: (index: number, height: number) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadSection(index)
      .then((h) => alive && setHtml(h))
      .catch((err) => {
        console.error("[virtual-docs] section load failed", index, err);
        if (alive) setHtml("<p>（本节加载失败）</p>");
      });
    return () => {
      alive = false;
    };
  }, [index, loadSection]);

  if (html == null) return <div style={{ height: estimatedHeight ?? 200 }} />;
  return (
    <SectionFrame
      index={index}
      html={html}
      styleCss={styleCss}
      onSelect={onSelect}
      onSelectionCleared={onSelectionCleared}
      decorate={decorate}
      onHighlightClick={onHighlightClick}
      decorateNonce={decorateNonce}
      onContentMouseDown={onContentMouseDown}
      estimatedHeight={estimatedHeight}
      onMeasured={onMeasured}
    />
  );
}
```

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 全绿。

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx
git commit -m "feat(virtual-docs): measured-height cache feeds placeholder estimate

VirtualDocs 维护 index→height 缓存（SectionFrame.onMeasured 写入），占位用 estimateHeight；
styleCss 变更整体失效。减少 unload 重进 / 回滚时的二次跳。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `VirtualDocs` ② 距离阈值主动 unload

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`（import、Props、组件体、`<Virtuoso>` 的 rangeChanged）

> `sectionsToUnload` 纯逻辑已在 T1 测；本 task 是接线，靠 typecheck + 末尾真书手测（内存回落）。

- [ ] **Step 1: import + 常量**

把 T4 的 precision import 扩展为：

```ts
import { estimateHeight, sectionsToUnload } from "./precision";
```

在 `DEFAULT_ESTIMATE` 旁加：

```ts
/** active range 两侧各保留的 section 数；超出即 unload。 */
const KEEP_DISTANCE = 5;
```

- [ ] **Step 2: Props 加 `onUnloadSection`**

在 `VirtualDocsProps`（`onContentMouseDown` 之后）加：

```ts
  /** 某 section 离开「active range ± KEEP_DISTANCE」时回调一次，供消费方释放其资源。 */
  onUnloadSection?: (index: number) => void;
```

并在组件参数解构里加 `onUnloadSection`。

- [ ] **Step 3: 组件体维护 unloaded 集 + rangeChanged 协调**

在 `heightCache` ref 旁加：

```ts
// 已 unload 的 section 集：避免重复 unload；section 重新进入保留区时移除（届时会 reload）。
const unloaded = useRef<Set<number>>(new Set());
```

把 `<Virtuoso>` 的 `rangeChanged`（`:92`）替换为：

```ts
      rangeChanged={(range) => {
        onTopIndexChange?.(range.startIndex);
        // 保留区内的从 unloaded 移除（将/已 reload）
        const lo = Math.max(0, range.startIndex - KEEP_DISTANCE);
        const hi = Math.min(count - 1, range.endIndex + KEEP_DISTANCE);
        for (let i = lo; i <= hi; i++) unloaded.current.delete(i);
        // 保留区外、尚未 unload 的 → unload 一次
        for (const i of sectionsToUnload(range, count, KEEP_DISTANCE)) {
          if (!unloaded.current.has(i)) {
            unloaded.current.add(i);
            onUnloadSection?.(i);
          }
        }
      }}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 全绿。

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx
git commit -m "feat(virtual-docs): distance-threshold section unload via onUnloadSection

rangeChanged 时按 sectionsToUnload 算保留区外集合，对未 unload 的回调一次 onUnloadSection；
section 重进保留区即从已卸载集移除。长书内存有界。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `VirtualDocs` ③ IntersectionObserver 精确视口顶

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`（import、Props：`onTopIndexChange` → `onTopSectionChange`、组件体 IO、LazySection 注册外层 div、`<Virtuoso scrollerRef>`）

> `topVisibleIndex` 纯逻辑已在 T1 测；IO 接线靠 typecheck + 末尾真书手测（当前章跟手）。

- [ ] **Step 1: import**

把 precision import 扩展为：

```ts
import { estimateHeight, sectionsToUnload, topVisibleIndex } from "./precision";
```

- [ ] **Step 2: Props 把 `onTopIndexChange` 改为 `onTopSectionChange`**

把 `VirtualDocsProps` 里的 `onTopIndexChange`（含 `:21-25` 注释）替换为：

```ts
  /**
   * 真实视口顶 section 索引变化时回调。优先用 IntersectionObserver 精确计算；
   * IntersectionObserver 不可用时 fallback 到 virtuoso rangeChanged.startIndex（近似，含 overscan）。
   */
  onTopSectionChange?: (index: number) => void;
```

并把组件参数解构里的 `onTopIndexChange` 改为 `onTopSectionChange`。

- [ ] **Step 3: 组件体——scroller ref + IO + section 注册表 + recompute**

在 `unloaded` ref 旁加：

```ts
const scrollerEl = useRef<HTMLElement | null>(null);
const observedEls = useRef<Map<number, HTMLElement>>(new Map());
const io = useRef<IntersectionObserver | null>(null);
const lastTop = useRef<number | null>(null);

// 对所有当前注册的 section 同步测 rect → 纯函数挑视口顶 → 去重上报。
const recomputeTop = () => {
  const scroller = scrollerEl.current;
  if (!scroller) return;
  const vt = scroller.getBoundingClientRect().top;
  const secs = [...observedEls.current.entries()].map(([index, el]) => {
    const r = el.getBoundingClientRect();
    return { index, top: r.top, bottom: r.bottom };
  });
  const idx = topVisibleIndex(secs, vt);
  if (idx != null && idx !== lastTop.current) {
    lastTop.current = idx;
    onTopSectionChange?.(idx);
  }
};

const ioSupported = typeof IntersectionObserver !== "undefined";

// 注册/注销由 LazySection 在挂载/卸载时调用。
const registerSection = (index: number, el: HTMLElement) => {
  observedEls.current.set(index, el);
  io.current?.observe(el);
};
const unregisterSection = (index: number, el: HTMLElement) => {
  observedEls.current.delete(index);
  io.current?.unobserve(el);
};

// scroller 就绪后建 IO，observe 已注册的元素。
useEffect(() => {
  if (!ioSupported) return;
  const scroller = scrollerEl.current;
  if (!scroller) return;
  const obs = new IntersectionObserver(() => recomputeTop(), { root: scroller });
  io.current = obs;
  for (const el of observedEls.current.values()) obs.observe(el);
  return () => {
    obs.disconnect();
    io.current = null;
  };
  // scrollerReady nonce 触发重建（见 Step 5 的 scrollerRef）
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [scrollerReady, ioSupported]);
```

- [ ] **Step 4: 加 scrollerReady state（触发 IO useEffect）**

在 `decorateNonce` state 旁（`:49`）加：

```ts
const [scrollerReady, setScrollerReady] = useState(0);
```

- [ ] **Step 5: `<Virtuoso>` 接 scrollerRef + rangeChanged 兼容 fallback**

给 `<Virtuoso>` 加 `scrollerRef`，并把 Step 5(T5) 的 rangeChanged 里 `onTopIndexChange?.(range.startIndex)` 改为「仅 IO 不可用时 fallback」：

```tsx
<Virtuoso
  ref={vRef}
  style={{ height: "100%" }}
  totalCount={count}
  initialTopMostItemIndex={initialIndex ?? 0}
  itemContent={itemContent}
  scrollerRef={(el) => {
    scrollerEl.current = el instanceof HTMLElement ? el : null;
    setScrollerReady((n) => n + 1);
  }}
  rangeChanged={(range) => {
    if (!ioSupported) onTopSectionChange?.(range.startIndex); // fallback：近似
    const lo = Math.max(0, range.startIndex - KEEP_DISTANCE);
    const hi = Math.min(count - 1, range.endIndex + KEEP_DISTANCE);
    for (let i = lo; i <= hi; i++) unloaded.current.delete(i);
    for (const i of sectionsToUnload(range, count, KEEP_DISTANCE)) {
      if (!unloaded.current.has(i)) {
        unloaded.current.add(i);
        onUnloadSection?.(i);
      }
    }
  }}
/>
```

- [ ] **Step 6: LazySection 包注册用外层 div**

把 `itemContent`（T4 Step 3）改为外层包一个带 ref 的 div，并把注册回调透传给 LazySection：

```tsx
const itemContent = (index: number) => (
  <LazySection
    index={index}
    loadSection={loadSection}
    styleCss={styleCss}
    onSelect={onSelect}
    onSelectionCleared={onSelectionCleared}
    decorate={decorate}
    onHighlightClick={onHighlightClick}
    decorateNonce={decorateNonce}
    onContentMouseDown={onContentMouseDown}
    estimatedHeight={estimateHeight(heightCache.current, index, DEFAULT_ESTIMATE)}
    onMeasured={onMeasured}
    registerSection={registerSection}
    unregisterSection={unregisterSection}
  />
);
```

在 `LazySection` 参数与类型里加 `registerSection`/`unregisterSection`，并用一个外层 div 包裹其返回内容、在 effect 里注册：

```tsx
function LazySection({
  index,
  loadSection,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  decorateNonce,
  onContentMouseDown,
  estimatedHeight,
  onMeasured,
  registerSection,
  unregisterSection,
}: {
  index: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  decorateNonce?: number;
  onContentMouseDown?: () => void;
  estimatedHeight?: number;
  onMeasured?: (index: number, height: number) => void;
  registerSection: (index: number, el: HTMLElement) => void;
  unregisterSection: (index: number, el: HTMLElement) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    loadSection(index)
      .then((h) => alive && setHtml(h))
      .catch((err) => {
        console.error("[virtual-docs] section load failed", index, err);
        if (alive) setHtml("<p>（本节加载失败）</p>");
      });
    return () => {
      alive = false;
    };
  }, [index, loadSection]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    registerSection(index, el);
    return () => unregisterSection(index, el);
  }, [index, registerSection, unregisterSection]);

  return (
    <div ref={outerRef} data-section-index={index}>
      {html == null ? (
        <div style={{ height: estimatedHeight ?? 200 }} />
      ) : (
        <SectionFrame
          index={index}
          html={html}
          styleCss={styleCss}
          onSelect={onSelect}
          onSelectionCleared={onSelectionCleared}
          decorate={decorate}
          onHighlightClick={onHighlightClick}
          decorateNonce={decorateNonce}
          onContentMouseDown={onContentMouseDown}
          estimatedHeight={estimatedHeight}
          onMeasured={onMeasured}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 7: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 全绿。

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx
git commit -m "feat(virtual-docs): precise top-section via IntersectionObserver (onTopSectionChange)

IO（root=scroller）观察各 section，纯函数 topVisibleIndex 挑真实视口顶上报 onTopSectionChange，
去重；IO 不可用 fallback 回 rangeChanged.startIndex。取代含 overscan 的 onTopIndexChange。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `EpubReader` 集成（消费新回调 + 转发 unload）

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`（`onTopIndexChange` `:119-139`、`<VirtualDocs>` `:206-224`）

> 无 headless 测；本 task 完成后执行末尾「真书手测验收清单」。

- [ ] **Step 1: 把 `onTopIndexChange` 重命名为 `onTopSectionChange`**

把 `const onTopIndexChange = (index: number) => {`（`:119`）改名为：

```ts
  const onTopSectionChange = (index: number) => {
```

函数体不变（当前章高亮 + 防抖存进度逻辑照旧；只是 index 现在精确）。

- [ ] **Step 2: `<VirtualDocs>` 接新回调 + 转发 unload**

把 `<VirtualDocs ...>`（`:206-224`）的 `onTopIndexChange={onTopIndexChange}` 改为，并加 `onUnloadSection`：

```tsx
        onTopSectionChange={onTopSectionChange}
        onUnloadSection={(i) => book.unloadSection(i)}
```

（此处 `book` 已在 `:196` 的守卫后非空——`if (!book || progress.isLoading) return ...` 之后才 render `<VirtualDocs>`。）

- [ ] **Step 3: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误（`onTopIndexChange` prop 已不存在于 VirtualDocsProps，旧名会报错——确认已全部改名）。

Run: `pnpm test`
Expected: 全绿。

```bash
git add src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): consume precise onTopSectionChange + forward onUnloadSection

EpubReader 改用精确视口顶回调（当前章跟手）；转发 unload 到 EpubBook.unloadSection（长书内存有界）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 真书手测验收清单（Task 7 后执行）

`pnpm start`，导入一本**含图片的长书**（spine 项数 > 30），逐项确认：

1. **① 高度稳定**：从中部向**上**滚动，含图片的段落进入视口顶**不跳动/不闪**；快速上下滚动若干来回，滚动位置不漂移。
2. **② 长书内存**：从头滚到尾再滚回。DevTools Memory 取两次 heap snapshot（开头 vs 全程滚动后回到开头），常驻 `HTMLDocument`/detached DOM 不随访问 section 数线性增长（远离视口的已释放）。滚回已 unload 的章节能正常重新渲染。
3. **③ 当前章跟手**：缓慢滚动，侧栏「当前章」高亮对应**真实视口顶**所在章（不再滞后一两章）。
4. **回归**：选区→工具栏→提问、标注高亮渲染/点击编辑、跳章、进度保存与重开恢复——均正常（CFI 不变量未被 unload 破坏）。
5. **改字号偏好**：调字号后高度重新稳定、无残留错位（测高缓存已失效重测）。

任一不达预期→记录现象，回到对应 Task 修正。

---

## Self-Review

**1. Spec 覆盖（对照 design 文档）：**

- ① SectionFrame 就绪后上报稳定高度 + 测高缓存占位 → T3 + T4。✅
- ② 距离阈值 unload + epub-book.unloadSection + CFI 安全（仅可见 section 调 CFI）→ T2 + T5。✅
- ③ IntersectionObserver 精确视口顶 + fallback → T6；EpubReader 消费 → T7。✅
- 纯逻辑 headless 单测（topVisibleIndex/sectionsToUnload/estimateHeight）→ T1。✅
- 与 #10 正交（不改 reader-store 结构，仅 EpubReader 回调改名/转发）→ T7。✅
- 不碰 #8/IPC、不碰封面/书库。✅
- 不做方案 B（持久化高度表/主进程预解析图片）。✅

**2. 占位扫描：** 无 TBD/TODO；纯逻辑步骤给完整测试+实现代码；DOM 接线步骤给完整改后代码并显式声明「无 headless 测，靠 typecheck + 末尾真书手测」（非占位，是有意的验证策略——契合 spec 选定的「纯逻辑单测 + 真书手测」）。✅

**3. 类型/命名一致性：** `estimateHeight`/`sectionsToUnload`/`topVisibleIndex`（T1 定义，T4/T5/T6 消费签名一致）；`onMeasured(index,height)`（T3 定义、T4 写缓存）；`estimatedHeight`（T3 prop、T4 传值）；`onUnloadSection(index)`（T5 prop、T7 转发到 T2 的 `unloadSection`）；`onTopSectionChange(index)`（T6 prop 取代 `onTopIndexChange`、T7 消费）；`registerSection`/`unregisterSection`（T6 定义与 LazySection 消费一致）。VirtualDocsProps 移除 `onTopIndexChange`，T7 已同步改名（typecheck 兜底）。✅

**4. 执行顺序无悬空：** T1（纯逻辑）→ T2（unloadSection）→ T3（SectionFrame）→ T4（缓存，依赖 T3 的 onMeasured/estimatedHeight）→ T5（unload，依赖 T2 的 unloadSection 经 T7 接线、但 T5 仅加 VirtualDocs prop，运行时接线在 T7）→ T6（IO，依赖 T4/T5 的 itemContent/LazySection 形态，本 task 改写同处）→ T7（EpubReader 接线，激活 ②③）。T5/T6 都改 `VirtualDocs.tsx` 同区域（itemContent/Virtuoso），按序执行无冲突。✅
