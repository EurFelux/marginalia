# PDF 支持 P3（标注：overlay 高亮 + 点击编辑 + 侧栏互通）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF 高亮标注全闭环——选区建标注（P2 已产 locatorRange）、矩形 overlay 绘制、点击编辑、跨重启恢复、与 ePub 标注共用侧栏。

**Architecture:** 页内偏移（locatorRange `pdf:{"page","start","end"}`）经 `rangeFromOffsets`（flatOffsetOf 的逆）还原成 textLayer DOM Range → `getClientRects()` → 相对页容器的矩形组 → 半透明色块 overlay（canvas 之上、textLayer 之下，**pointer-events-none 不挡划词**）；点击编辑走页容器 click 命中测试（选区未塌缩=拖选结尾不算点击）。复用既有 annotation-store / HighlightStyleBar / NoteModal / AnnotationsList——只补 PDF 排序键与章节标题分支。spec：`docs/superpowers/specs/2026-06-06-pdf-support-design.md` §4/§6/§9。

**Tech Stack:** 既有 annotations IPC（零主进程改动）、happy-dom（Range 构造可测）、Tailwind 色板。

**分支：** 全程在 `feat/pdf-support-p3`（已自 `feat/pdf-support` 切出）。完成后审核合回 `feat/pdf-support`（**不是 main**）。**任何 subagent 严禁 `git switch`/`git checkout` 切分支。**

---

## 关键事实（已对本仓代码核实）

1. **坐标空间**（spec §4 + P2 落地）：locatorRange 偏移 = textLayer DOM 的 text node 按文档序拼接（`pdf-selection.ts` 的 `flatOffsetOf` 产出、`pdf-locator.ts` 的 `parsePdfLocatorRange` 解析）。P3 绘制必须用**同一空间**（TreeWalker SHOW_TEXT 遍历同一 textLayer）。
2. **AnnotationDto**（`src/shared/annotations.ts`）：`{ id, bookId, style, note, selectedText, locatorRange, createdAt, updatedAt }`；style 枚举 `yellow|green|blue|pink|purple|underline`；create 走 `window.api.annotations.create`（SelectionToolbar/NoteModal 已接好，PDF 下 P2 被 `annotatable` 门控藏住——本期移除门控即接通）。
3. **annotation-store**（`src/renderer/store/annotation-store.ts`）：`openStyleBar({ rect, target: { type: "edit", annotationId } })` = 编辑入口（rect 为**视口坐标**）；`scrollCommand: { locator, nonce } | null` 由侧栏 `requestScroll(locator)` 触发，reader 自行解释 locator。
4. **PdfPage 现状**（P2 后，`PdfReader.tsx` 尾部）：props `{ book, index, cssWidth, cssHeight, invert }`；`task.done.catch(() => setRenderError(true))`；relative 容器内 canvas + `<div ref={textLayerRef} data-page={index+1} className="textLayer">`。`renderPage(...).done` 在 canvas+textLayer 两路都 settle 后 resolve——**done resolve 即 textLayer DOM 就绪**。
5. **AnnotationsList 排序**（`AnnotationsList.tsx:61-72`）：`cfiCompare.compare` 对 `pdf:` 串会 throw → catch 回退 `spineOf` 双 -1 → 顺序退化为入库序；章节标题经 `spinePos→orderIndex` 对 PDF 永远 null。需加 PDF 分支。
6. **色板**（`highlight.ts`）：`FILL_SWATCH`/`STYLE_STRIPE` 是主文档 Tailwind 类；`ANNO_IFRAME_CSS` 是 ePub iframe 专用字符串 CSS。PDF overlay 在主文档 → 用 Tailwind 类（新增 `OVERLAY_FILL`）。
7. **happy-dom**：`document.createRange` + `setStart/setEnd` 可用（P2 已装 devDep）；`getClientRects()` 返回空——矩形换算抽纯函数注入数据测，DOM 几何靠 CDP 冒烟。

---

## 文件结构总览

| 文件                                          | 动作 | 职责                                                                                                                                  |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/reader/pdf-annotations.ts`      | 新   | 纯函数：`rangeFromOffsets`（偏移→Range）、`pdfAnnosByPage`（按页分组）、`pdfOrderKey`（侧栏排序键）、`relativeRects`（视口→容器坐标） |
| `src/renderer/reader/pdf-annotations.test.ts` | 新   | happy-dom 测试                                                                                                                        |
| `src/renderer/reader/use-pdf-highlights.ts`   | 新   | `usePdfHighlights` hook：textLayer 就绪后算高亮矩形组                                                                                 |
| `src/renderer/reader/highlight.ts`            | 改   | 追加 `OVERLAY_FILL`（PDF overlay Tailwind 色板）                                                                                      |
| `src/renderer/reader/PdfReader.tsx`           | 改   | annotations query + 按页分组传 PdfPage；PdfPage 加 overlay 渲染 + textReady + 点击命中编辑；scrollCommand 消费                        |
| `src/renderer/reader/SelectionToolbar.tsx`    | 改   | **移除** P2 的 PDF `annotatable` 门控（高亮/笔记入口对 PDF 解锁）                                                                     |
| `src/renderer/reader/AnnotationsList.tsx`     | 改   | PDF 排序键 + 章节标题（章名 · p.N）分支                                                                                               |

---

### Task 1: pdf-annotations 纯函数 + 测试

**Files:**

- Create: `src/renderer/reader/pdf-annotations.ts`
- Test: `src/renderer/reader/pdf-annotations.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/reader/pdf-annotations.test.ts`：

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { AnnotationDto } from "@shared/annotations";
import { pdfAnnosByPage, pdfOrderKey, rangeFromOffsets, relativeRects } from "./pdf-annotations";

function layer(spans: string[]): HTMLElement {
  const div = document.createElement("div");
  for (const s of spans) {
    const span = document.createElement("span");
    span.textContent = s;
    div.appendChild(span);
  }
  return div;
}

describe("rangeFromOffsets", () => {
  it("maps flat offsets back to node-local positions across spans", () => {
    const root = layer(["Hello ", "world", "!"]); // 偏移 6..9 = "wor"
    const r = rangeFromOffsets(root, 6, 9);
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe("wor");
  });
  it("spans node boundaries", () => {
    const root = layer(["abc", "def"]); // 2..4 = "cd"
    expect(rangeFromOffsets(root, 2, 4)!.toString()).toBe("cd");
  });
  it("returns null for out-of-bounds or empty ranges", () => {
    const root = layer(["abc"]);
    expect(rangeFromOffsets(root, 2, 99)).toBeNull(); // end 越界（pdfjs 文本变化防御）
    expect(rangeFromOffsets(root, 2, 2)).toBeNull(); // 空区间
    expect(rangeFromOffsets(root, -1, 2)).toBeNull();
  });
});

describe("pdfAnnosByPage", () => {
  const anno = (id: string, locatorRange: string, note = ""): AnnotationDto => ({
    id,
    bookId: "b",
    style: "yellow",
    note,
    selectedText: "t",
    locatorRange,
    createdAt: 0,
    updatedAt: 0,
  });

  it("groups by page and maps note to hasNote", () => {
    const m = pdfAnnosByPage([
      anno("a", 'pdf:{"page":3,"start":0,"end":5}'),
      anno("b", 'pdf:{"page":3,"start":10,"end":15}', "memo"),
      anno("c", 'pdf:{"page":7,"start":1,"end":2}'),
    ]);
    expect(m.get(3)?.map((x) => x.id)).toEqual(["a", "b"]);
    expect(m.get(3)?.[1]?.hasNote).toBe(true);
    expect(m.get(7)?.length).toBe(1);
  });

  it("skips non-pdf locators (cfi) silently", () => {
    const m = pdfAnnosByPage([anno("x", "epubcfi(/6/4!/4/2)")]);
    expect(m.size).toBe(0);
  });
});

describe("pdfOrderKey", () => {
  it("orders by page then in-page offset; null for cfi", () => {
    const k1 = pdfOrderKey('pdf:{"page":2,"start":500,"end":501}');
    const k2 = pdfOrderKey('pdf:{"page":3,"start":0,"end":1}');
    const k3 = pdfOrderKey('pdf:{"page":3,"start":80,"end":81}');
    expect(k1! < k2!).toBe(true);
    expect(k2! < k3!).toBe(true);
    expect(pdfOrderKey("epubcfi(/6/4!/4)")).toBeNull();
  });
});

describe("relativeRects", () => {
  it("converts viewport rects to container-relative and drops slivers", () => {
    const out = relativeRects(
      [
        { x: 110, y: 220, width: 50, height: 14 },
        { x: 110, y: 240, width: 0.4, height: 14 }, // 零宽碎片
      ],
      { x: 100, y: 200 },
    );
    expect(out).toEqual([{ left: 10, top: 20, width: 50, height: 14 }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-annotations.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/renderer/reader/pdf-annotations.ts`：

```ts
import type { AnnotationDto, AnnotationStyle } from "@shared/annotations";
import { parsePdfLocatorRange } from "./pdf-locator";

/** 单页标注（绘制输入）：locatorRange 解析后的页内偏移 + 视觉属性。 */
export interface PdfPageAnno {
  id: string;
  style: AnnotationStyle;
  hasNote: boolean;
  start: number;
  end: number;
}

/**
 * 把扁平偏移区间还原成 root 内的 DOM Range（flatOffsetOf 的逆；同一坐标空间：
 * textLayer text node 按文档序拼接，见 pdf-selection.ts 注记）。
 * 偏移越界（如 pdfjs 升级改变文本提取结果）或空区间 → null，调用方跳过绘制——
 * selectedText 重锚定兜底 v1 不实现（spec §11）。
 */
export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = (t.textContent ?? "").length;
    if (startNode === null && acc + len > start) {
      startNode = t;
      startOffset = start - acc;
    }
    if (acc + len >= end) {
      endNode = t;
      endOffset = end - acc;
      break;
    }
    acc += len;
  }
  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** 标注按页分组（绘制分发用）。非 pdf locator（防御）与解析失败一律静默跳过。 */
export function pdfAnnosByPage(annos: AnnotationDto[]): Map<number, PdfPageAnno[]> {
  const map = new Map<number, PdfPageAnno[]>();
  for (const a of annos) {
    const r = parsePdfLocatorRange(a.locatorRange);
    if (!r) continue;
    const arr = map.get(r.page) ?? [];
    arr.push({
      id: a.id,
      style: a.style,
      hasNote: a.note.trim().length > 0,
      start: r.start,
      end: r.end,
    });
    map.set(r.page, arr);
  }
  return map;
}

/** PDF 标注阅读序排序键（页主序、页内偏移次序）；非 pdf locator → null（走 CFI 路径）。 */
export function pdfOrderKey(locator: string): number | null {
  const r = parsePdfLocatorRange(locator);
  return r ? r.page * 1_000_000 + Math.min(r.start, 999_999) : null;
}

/** 相对容器坐标的 overlay 矩形。 */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 视口坐标矩形 → 相对容器坐标；丢弃 <1px 的零尺寸碎片（getClientRects 的折行渣）。 */
export function relativeRects(
  rects: Iterable<{ x: number; y: number; width: number; height: number }>,
  container: { x: number; y: number },
): OverlayRect[] {
  const out: OverlayRect[] = [];
  for (const r of rects) {
    if (r.width < 1 || r.height < 1) continue;
    out.push({ left: r.x - container.x, top: r.y - container.y, width: r.width, height: r.height });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-annotations.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/pdf-annotations.ts src/renderer/reader/pdf-annotations.test.ts
git commit -m "feat(reader): pdf annotation offsets-to-range and grouping helpers"
```

---

### Task 2: overlay 高亮渲染 + 点击编辑（PdfPage）

**背景**：spec §6——「locatorRange 偏移 → textLayer Range → getClientRects() → 半透明矩形 overlay；**不往 textLayer 包 `<mark>`**（span 绝对定位 transform，插节点破坏排版）；点击 overlay 矩形 = 编辑入口」。设计决策：overlay 视觉层 `pointer-events-none`（不挡原生划词），点击编辑走页容器 click 命中测试（选区未塌缩 = 拖选结尾，不算点击）。本任务无 headless 测试（DOM 几何），以 typecheck/lint/test 无回归 + Task 5 冒烟验收。

**Files:**

- Modify: `src/renderer/reader/highlight.ts`
- Create: `src/renderer/reader/use-pdf-highlights.ts`
- Modify: `src/renderer/reader/PdfReader.tsx`（仅 PdfPage 组件）

- [ ] **Step 1: highlight.ts 追加 OVERLAY_FILL**

```ts
/**
 * PDF 高亮 overlay 矩形样式（主文档 Tailwind 生效；半透明色块叠在 canvas 上、
 * textLayer 之下）。underline 不填充、画底边线。暗色下 canvas 反色但 overlay
 * 不反（在 canvas 元素之外），45% 透明度两种模式均可读。
 */
export const OVERLAY_FILL: Record<AnnotationStyle, string> = {
  yellow: "bg-yellow-300/45",
  green: "bg-green-300/45",
  blue: "bg-sky-300/45",
  pink: "bg-pink-300/45",
  purple: "bg-purple-300/45",
  underline: "border-b-2 border-foreground/60",
};
```

- [ ] **Step 2: 新建 use-pdf-highlights.ts**

```ts
import { useEffect, useState } from "react";
import type { AnnotationStyle } from "@shared/annotations";
import {
  rangeFromOffsets,
  relativeRects,
  type OverlayRect,
  type PdfPageAnno,
} from "./pdf-annotations";

/** 一条可绘制矩形（一条标注跨行 = 多条记录，annoId 相同）。 */
export interface HighlightRect {
  annoId: string;
  style: AnnotationStyle;
  hasNote: boolean;
  rect: OverlayRect;
}

/**
 * 本页高亮矩形组：textLayer 渲染就绪（renderPage done）后，把每条标注的页内偏移
 * 经 Range.getClientRects() 转成相对页容器的矩形。偏移越界的标注画不出 → 跳过
 * （spec §11：selectedText 重锚定兜底 v1 不实现）。zoom 换档时 PdfPage 整体重挂
 * （computeItemKey 含 pageW），矩形随新布局重算。
 */
export function usePdfHighlights(
  annos: PdfPageAnno[],
  textLayer: HTMLDivElement | null,
  ready: boolean,
): HighlightRect[] {
  const [rects, setRects] = useState<HighlightRect[]>([]);
  useEffect(() => {
    if (!ready || !textLayer || annos.length === 0) {
      setRects([]);
      return;
    }
    const containerRect = textLayer.getBoundingClientRect();
    const out: HighlightRect[] = [];
    for (const a of annos) {
      const range = rangeFromOffsets(textLayer, a.start, a.end);
      if (!range) continue;
      for (const rect of relativeRects(range.getClientRects(), containerRect)) {
        out.push({ annoId: a.id, style: a.style, hasNote: a.hasNote, rect });
      }
    }
    setRects(out);
  }, [annos, textLayer, ready]);
  return rects;
}
```

- [ ] **Step 3: PdfPage 集成**

`src/renderer/reader/PdfReader.tsx`——import 追加（并入现有行）：

```ts
import type { MouseEvent as ReactMouseEvent } from "react";
import { OVERLAY_FILL } from "./highlight";
import type { PdfPageAnno } from "./pdf-annotations";
import { usePdfHighlights } from "./use-pdf-highlights";
// useAnnotationStore 已有 import
```

`PdfPage` 组件整体改为：

```tsx
/** 单页：canvas + 高亮 overlay + textLayer 三层叠放；卸载/参数变化取消未完成渲染。 */
function PdfPage(props: {
  book: PdfBook;
  index: number;
  cssWidth: number;
  cssHeight: number;
  invert: boolean;
  annos: PdfPageAnno[];
}) {
  const { book, index, cssWidth, cssHeight, invert, annos } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);
  // renderPage done = canvas+textLayer 两路都 settle → 偏移可以安全还原成 Range。
  const [textReady, setTextReady] = useState(false);
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const highlights = usePdfHighlights(annos, textLayerRef.current, textReady);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRenderError(false);
    setTextReady(false);
    const task = book.renderPage(index, canvas, cssWidth, textLayerRef.current ?? undefined);
    task.done.then(() => setTextReady(true)).catch(() => setRenderError(true));
    return () => task.cancel();
  }, [book, index, cssWidth]);

  // 点击命中高亮 → 编辑样式栏（对齐 ePub onHighlightClick）。视觉矩形 pointer-events-none
  // 不挡划词；命中测试走容器 click——选区未塌缩 = 拖选结尾，不当点击。
  const onClick = (e: ReactMouseEvent) => {
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const layer = textLayerRef.current;
    if (!layer || highlights.length === 0) return;
    const base = layer.getBoundingClientRect();
    const x = e.clientX - base.x;
    const y = e.clientY - base.y;
    const hit = highlights.find(
      (h) =>
        x >= h.rect.left &&
        x <= h.rect.left + h.rect.width &&
        y >= h.rect.top &&
        y <= h.rect.top + h.rect.height,
    );
    if (!hit) return;
    openStyleBar({
      rect: {
        x: hit.rect.left + base.x,
        y: hit.rect.top + base.y,
        width: hit.rect.width,
        height: hit.rect.height,
      },
      target: { type: "edit", annotationId: hit.annoId },
    });
  };

  return (
    <div className="flex justify-center py-2">
      {renderError ? (
        <div
          className="flex items-center justify-center bg-muted font-sans text-xs text-muted-foreground"
          // 运行时计算的页面尺寸（规范允许内联承载运行时值）
          style={{ width: cssWidth, height: cssHeight }}
        >
          ⚠ p.{index + 1}
        </div>
      ) : (
        <div
          className="relative shadow-sm"
          style={{ width: cssWidth, height: cssHeight }}
          onClick={onClick}
        >
          <canvas
            ref={canvasRef}
            className={cn("h-full w-full", invert && "[filter:invert(1)_hue-rotate(180deg)]")}
          />
          {/* 高亮 overlay：canvas 之上、textLayer 之下；纯视觉不接事件（不挡原生划词）。 */}
          <div className="pointer-events-none absolute inset-0">
            {highlights.map((h, i) => (
              <div
                key={`${h.annoId}-${i}`}
                className={cn("absolute", OVERLAY_FILL[h.style])}
                // 运行时计算的矩形几何
                style={{
                  left: h.rect.left,
                  top: h.rect.top,
                  width: h.rect.width,
                  height: h.rect.height,
                }}
              />
            ))}
          </div>
          {/* data-page：选区处理据此识别页号（1-based）。invert 滤镜只作用于 canvas。 */}
          <div ref={textLayerRef} data-page={index + 1} className="textLayer" />
        </div>
      )}
    </div>
  );
}
```

**本步暂时**在 PdfReader 的 `itemContent` 里给 `<PdfPage ... annos={[]} />` 传空数组占位（Task 3 接真数据），保证编译。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿（无回归）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/highlight.ts src/renderer/reader/use-pdf-highlights.ts src/renderer/reader/PdfReader.tsx
git commit -m "feat(reader): pdf highlight overlay rendering and click-to-edit"
```

---

### Task 3: PdfReader 接数据 + 侧栏跳转（scrollCommand）

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`（PdfReader 主组件）

- [ ] **Step 1: annotations query + 分组 + 传 props**

import 追加：

```ts
import { pdfAnnosByPage } from "./pdf-annotations";
import { parsePdfLocatorRange } from "./pdf-locator"; // makePdfLocator/parsePdfLocator 行已有，并入
```

PdfReader 组件内（既有 progress query 之后）：

```ts
// 标注：对齐 EpubReader 的 query 配置；建/改/删后 invalidate 自动重画。
const annotations = useQuery({
  queryKey: qk.annotations(bookId),
  queryFn: () => window.api.annotations.listByBook({ bookId }),
  staleTime: Infinity,
});
const scrollCommand = useAnnotationStore((s) => s.scrollCommand);
```

主渲染分支（`pageW` 计算附近）：

```ts
// 标注按页分组（每渲染重算；可见页 × 条数级，开销可忽略——React Compiler 亦会缓存）。
const annosByPage = pdfAnnosByPage(annotations.data ?? []);
```

`itemContent` 的占位空数组改为：

```tsx
<PdfPage
  book={book}
  index={index}
  cssWidth={pageW}
  cssHeight={pageH}
  invert={resolvedTheme === "dark"}
  annos={annosByPage.get(index + 1) ?? []}
/>
```

- [ ] **Step 2: scrollCommand 消费（侧栏点击 → 跳标注页）**

跳章 effect 之后追加：

```ts
// 侧栏标注列表点击 → 滚到标注所在页（对齐 EpubReader 的 scrollCommand 消费；
// 非 pdf locator 解析为 null → no-op，与 ePub locator 互不串台）。
useEffect(() => {
  if (!book || !scrollCommand) return;
  const r = parsePdfLocatorRange(scrollCommand.locator);
  if (r) virtuosoRef.current?.scrollToIndex({ index: r.page - 1, align: "start" });
}, [book, scrollCommand]);
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/PdfReader.tsx
git commit -m "feat(reader): feed annotations into pdf pages and honor sidebar scroll requests"
```

---

### Task 4: SelectionToolbar 门控移除 + AnnotationsList PDF 适配

**Files:**

- Modify: `src/renderer/reader/SelectionToolbar.tsx`
- Modify: `src/renderer/reader/AnnotationsList.tsx`
- Test: `src/renderer/reader/pdf-annotations.test.ts`（pdfOrderKey 已在 Task 1 覆盖，无新增）

- [ ] **Step 1: SelectionToolbar 还原**

移除 P2 的门控（其注释写明「P3 接通绘制后移除此门控」）：删掉 `book` useQuery、`annotatable` 常量及其条件包裹，高亮/笔记/分隔符恢复无条件渲染；若 `useQuery` import 与 `qk` import 因此不再被使用则一并清掉（lint 会兜底）。完成后 PDF 与 ePub 的选区工具栏完全一致。

- [ ] **Step 2: AnnotationsList 排序 + 章节标题分支**

import 追加：

```ts
import { chapterIdAtPage } from "./pdf-chapter-at-page";
import { parsePdfLocatorRange } from "./pdf-locator";
import { pdfOrderKey } from "./pdf-annotations";
```

排序（替换现 sorted）：

```ts
// 阅读序排序：PDF 标注按页+页内偏移；ePub 走 CFI compare（不可比时回退 spinePos）。
// 同一本书不会混两种 locator，两键同时非 null 即 PDF 书。
const sorted = [...list].sort((a, b) => {
  const ka = pdfOrderKey(a.locatorRange);
  const kb = pdfOrderKey(b.locatorRange);
  if (ka != null && kb != null) return ka - kb;
  try {
    return cfiCompare.compare(a.locatorRange, b.locatorRange);
  } catch {
    return spineOf(a.locatorRange) - spineOf(b.locatorRange);
  }
});
```

章节标题（替换现 chapterTitle）：

```ts
const chapterTitle = (locator: string): string | null => {
  const pdfRange = parsePdfLocatorRange(locator);
  if (pdfRange) {
    // PDF：页 → 所属章标题 + 页号；无章（首章前/无 outline 单章退化也有 startPage）退页号。
    const chId = chapterIdAtPage(chapters.data ?? [], pdfRange.page);
    const title = (chapters.data ?? []).find((c: ChapterRefDto) => c.id === chId)?.title;
    return title ? `${title} · p.${pdfRange.page}` : `p.${pdfRange.page}`;
  }
  const sp = spineOf(locator);
  const ch = (chapters.data ?? []).find((c: ChapterRefDto) => c.orderIndex === sp);
  return ch?.title ?? null;
};
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/SelectionToolbar.tsx src/renderer/reader/AnnotationsList.tsx
git commit -m "feat(reader): unlock pdf annotation entry points and adapt sidebar list"
```

---

### Task 5: 全量验证 + CDP 冒烟 + 终审（控制器亲自执行，不派 subagent）

- [ ] **Step 1: 全量验证**

Run: `pnpm i18n:extract && git status --short && pnpm typecheck && pnpm lint && pnpm test`
Expected: extract 零实质 diff（本期无新 t() 键；「· p.N」格式中立不走 i18n）；其余全绿。

- [ ] **Step 2: CDP 真启动冒烟**

`pnpm start -- --remote-debugging-port=9222`，清单：

1. **建高亮**：文字版 PDF 划词 → 工具栏六件套（高亮/笔记入口已解锁）→ 点「高亮标记」→ 半透明矩形立即出现 + HighlightStyleBar 弹出 → 换色生效（矩形重画）
2. **添加笔记**：划词 → 「添加笔记」→ NoteModal 保存 → 侧栏标注列表可见笔记
3. **点击编辑**：点击已有高亮矩形 → styleBar 弹出（edit 模式）→ 删除 → 矩形消失
4. **跨重启恢复**：reload → 开同书滚到该页 → 高亮矩形稳定恢复（offset→Range→矩形全链路）
5. **缩放回归**：换档 → 矩形随新布局对齐；划词建新高亮仍正确
6. **侧栏互通**：标注列表按页序排列、显示「章名 · p.N」、点击跳到标注页
7. **划词不被挡**：在已有高亮区域上可以再划词（overlay pointer-events-none 生效）
8. **暗色模式**：高亮色块在反色 canvas 上可读
9. **ePub 回归**（《古事记》）：标注创建/绘制/点击编辑/侧栏排序与标题不受影响

- [ ] **Step 3: 修复冒烟发现的问题并提交**

每个修复独立 commit（`fix(reader): ...`）。

- [ ] **Step 4: 终审**

派最终整体审查 agent（整个 P3 diff vs spec §4/§6/§9 P3 验收：「高亮跨重启稳定恢复；与 ePub 标注共用侧栏」），READY TO MERGE 后合回 `feat/pdf-support`。

---

## Self-Review 备忘（计划完成后已自查）

- spec §6「不往 textLayer 包 mark」→ overlay 独立层 ✓；「点击 overlay = 编辑入口」→ 命中测试方案（视觉层不接事件的理由已写明：不挡划词）✓；§9 P3 验收两条均有任务与冒烟覆盖 ✓。
- spec §4 坐标空间：rangeFromOffsets 与 flatOffsetOf 同空间（同 TreeWalker SHOW_TEXT 遍历）✓。
- 有笔记标注的视觉记号（ePub 是 dotted underline）PDF v1 不做（侧栏可见笔记），记 ROADMAP 延后项。
- 类型一致性：`PdfPageAnno`/`OverlayRect`/`HighlightRect` 在 Task 1/2/3 间签名一致；`pdfOrderKey`/`chapterIdAtPage` 复用 P2 既有导出。
- 主进程零改动（annotations IPC P1 前既有）。
