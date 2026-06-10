# PDF 阅读打磨实现计划（精确恢复 · 笔记标记 · 滚轮缩放）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 spec `docs/superpowers/specs/2026-06-10-pdf-reading-polish-design.md` 的三个子项：PDF 进度页内精确恢复（scrollRatio）、带笔记标注的点状底边记号、Ctrl+滚轮/触控板捏合的光标锚点缩放。

**Architecture:** 全部改动在渲染层 `src/renderer/reader/`。滚动几何抽成纯函数新文件 `pdf-scroll.ts`（headless 单测），笔记记号语义集中到 `highlight.ts`（共享谓词 `hasNote` + PDF overlay 类映射 `overlayClass`），缩放公式 `nextZoom` 进 `pdf-zoom.ts`；`PdfReader.tsx` 只做接线（save/restore、wheel 监听 + rAF 节流 + useLayoutEffect 锚点复位）。

**Tech Stack:** React 19（渲染层启用 React Compiler——**别手写 useCallback/useMemo**）、react-virtuoso、zustand prefs-store、vitest 4（DOM 测试用 `// @vitest-environment happy-dom` 头注释）、Tailwind。

**执行约束（每个 subagent 都要遵守）：**

- 工作分支 `feat/pdf-reading-polish`（Task 0 创建）；**禁止切换分支**，提交前确认 `git branch --show-current` 输出该分支名。
- pre-commit hook（prek）可能以 "files were modified by this hook" 中止提交：重新 `git add` 被改文件、原命令再跑一次即可。
- 测试命令：`pnpm test <file>`（vitest 跑在 Electron 运行时，正常现象：启动横幅带 Electron 字样）。

---

### Task 0: 建分支

**Files:** 无代码改动。

- [ ] **Step 1: 从 main 建特性分支**

```bash
git checkout -b feat/pdf-reading-polish
```

Expected: `Switched to a new branch 'feat/pdf-reading-polish'`

---

### Task 1: `pdf-scroll.ts` 滚动几何纯函数

**Files:**

- Create: `src/renderer/reader/pdf-scroll.ts`
- Test: `src/renderer/reader/pdf-scroll.test.ts`

背景：`PdfReader.tsx` 的 Virtuoso 列表里每项总高 = `pageH + 16`（`py-2` 上下各 8px），第 `page` 页（1-based）内容顶 = `(page-1)*(pageH+16) + 8`。现有顶页推算公式散落在 `PdfReader.tsx` 的 `rangeChanged` 里（`Math.floor((scrollTop + 8) / (pageH + 16)) + 1`），本任务把它和新的页内比例换算集中成纯函数。**`topPageAt` 的 +8 归属规则必须与原实现逐位一致**（行为保持）。

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/reader/pdf-scroll.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { intraPageRatio, scrollTopFor, topPageAt } from "./pdf-scroll";

const pageH = 1000; // 每项总高 1016

describe("topPageAt", () => {
  it("容器顶与首页中部都算第 1 页", () => {
    expect(topPageAt(0, pageH, 10)).toBe(1);
    expect(topPageAt(500, pageH, 10)).toBe(1);
  });
  it("+8 归属规则与 PdfReader 原实现一致：1007 仍第 1 页、1008 起第 2 页", () => {
    expect(topPageAt(1007, pageH, 10)).toBe(1);
    expect(topPageAt(1008, pageH, 10)).toBe(2);
  });
  it("clamp 到 [1, pageCount]（负值与超末尾）", () => {
    expect(topPageAt(-50, pageH, 10)).toBe(1);
    expect(topPageAt(99999, pageH, 3)).toBe(3);
  });
});

describe("intraPageRatio ↔ scrollTopFor 往返", () => {
  it("ratio 往返一致（页中部）", () => {
    const y = scrollTopFor(3, 0.4, pageH);
    expect(intraPageRatio(y, 3, pageH)).toBeCloseTo(0.4, 10);
  });
  it("ratio 0 / 1 端点", () => {
    expect(intraPageRatio(scrollTopFor(2, 0, pageH), 2, pageH)).toBe(0);
    expect(intraPageRatio(scrollTopFor(2, 1, pageH), 2, pageH)).toBe(1);
  });
  it("页缝区间 clamp 到边界", () => {
    // 第 2 页内容顶 = 1016+8 = 1024；其上方 4px（缝里）→ 0；内容底下方 4px → 1
    expect(intraPageRatio(1020, 2, pageH)).toBe(0);
    expect(intraPageRatio(1024 + pageH + 4, 2, pageH)).toBe(1);
  });
  it("内容内的 scrollTop 经 (page, ratio) 精确还原", () => {
    const y = 1024 + 123.45; // 第 2 页内容里
    const page = topPageAt(y, pageH, 10);
    expect(page).toBe(2);
    expect(scrollTopFor(page, intraPageRatio(y, page, pageH), pageH)).toBeCloseTo(y, 10);
  });
  it("页缝里的 scrollTop 还原误差不超过半缝（clamp 行为）", () => {
    for (const y of [0, 8, 1010]) {
      const page = topPageAt(y, pageH, 10);
      const back = scrollTopFor(page, intraPageRatio(y, page, pageH), pageH);
      expect(Math.abs(back - y)).toBeLessThanOrEqual(8);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-scroll.test.ts`
Expected: FAIL，报找不到模块 `./pdf-scroll`

- [ ] **Step 3: 写实现**

创建 `src/renderer/reader/pdf-scroll.ts`：

```ts
/**
 * PDF 页列表滚动几何（全书同尺寸前提，与 PdfReader 的 Virtuoso 布局耦合）：
 * 每项总高 = pageH + PAGE_GAP（页盒 py-2 上下各 8px），第 page 页（1-based）
 * 内容顶 = (page-1)*(pageH+PAGE_GAP) + PAGE_PADDING_Y。
 * 进度精确恢复与缩放光标锚点共用这套换算。
 */
export const PAGE_PADDING_Y = 8;
export const PAGE_GAP = 16;

/** 内容 Y（scrollTop / 光标绝对 Y）所在页：+8 把页缝归属切在缝中点附近，吸收跨页累计的亚像素误差。 */
export function topPageAt(y: number, pageH: number, pageCount: number): number {
  const page = Math.floor((y + PAGE_PADDING_Y) / (pageH + PAGE_GAP)) + 1;
  return Math.min(pageCount, Math.max(1, page));
}

/** 内容 Y 相对第 page 页的页内比例，clamp 到 [0,1]（页缝区间收敛到边界）。 */
export function intraPageRatio(y: number, page: number, pageH: number): number {
  const contentTop = (page - 1) * (pageH + PAGE_GAP) + PAGE_PADDING_Y;
  return Math.min(1, Math.max(0, (y - contentTop) / pageH));
}

/** 反向：页号 + 页内比例 → 内容 Y（intraPageRatio 的逆）。 */
export function scrollTopFor(page: number, ratio: number, pageH: number): number {
  return (page - 1) * (pageH + PAGE_GAP) + PAGE_PADDING_Y + ratio * pageH;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-scroll.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/pdf-scroll.ts src/renderer/reader/pdf-scroll.test.ts
git commit -m "feat(pdf): add pdf-scroll geometry helpers (page <-> scrollTop with intra-page ratio)"
```

---

### Task 2: 笔记记号——共享谓词 `hasNote` + `overlayClass` + 三处消费

**Files:**

- Modify: `src/renderer/reader/highlight.ts`
- Modify: `src/renderer/reader/apply-annotations.ts:67`
- Modify: `src/renderer/reader/pdf-annotations.ts:58`
- Modify: `src/renderer/reader/PdfReader.tsx`（PdfPage overlay，约 482 行）
- Test: `src/renderer/reader/highlight.test.ts`（新建）

语义：与 ePub 对齐——**有笔记 → 底边线变点状**。ePub 用 `.anno-noted`（dotted text-decoration，iframe 裸 CSS）；PDF overlay 是主文档里的空 div 矩形，用 Tailwind `border-dotted` 底边。policy（hasNote 谓词 + 「点状 = 有笔记」约定）共享，mechanism 分介质保持两份、并排互注。

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/reader/highlight.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { AnnotationStyle } from "@shared/annotations";
import { hasNote, OVERLAY_FILL, overlayClass } from "./highlight";

describe("hasNote", () => {
  it("空串与纯空白不算有笔记", () => {
    expect(hasNote("")).toBe(false);
    expect(hasNote("   \n\t")).toBe(false);
  });
  it("非空内容算有笔记", () => {
    expect(hasNote("一条笔记")).toBe(true);
  });
});

describe("overlayClass", () => {
  const styles: AnnotationStyle[] = ["yellow", "green", "blue", "pink", "purple", "underline"];
  it("无笔记 = OVERLAY_FILL 原值（行为不变）", () => {
    for (const s of styles) expect(overlayClass(s, false)).toBe(OVERLAY_FILL[s]);
  });
  it("有笔记的填充色保留填充、叠点状底边", () => {
    for (const s of styles.filter((x) => x !== "underline")) {
      const cls = overlayClass(s, true);
      expect(cls).toContain(OVERLAY_FILL[s]);
      expect(cls).toContain("border-dotted");
    }
  });
  it("underline 有笔记时实线底边换点状（不叠两条线）", () => {
    expect(overlayClass("underline", true)).toBe("border-b-2 border-dotted border-foreground/60");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/highlight.test.ts`
Expected: FAIL，报 `highlight.ts` 没有导出 `hasNote` / `overlayClass`

- [ ] **Step 3: 实现 `highlight.ts` 新增**

在 `src/renderer/reader/highlight.ts` 的 `OVERLAY_FILL` 常量之后追加：

```ts
/**
 * 「有笔记」判定：ePub 的 `.anno-noted`（apply-annotations.ts）与 PDF overlay 的
 * 点状底边（overlayClass）共用此谓词——语义改这里一处。
 */
export function hasNote(note: string): boolean {
  return note.trim().length > 0;
}

/**
 * PDF overlay 矩形类（含笔记记号）：有笔记 → 底边点状线，与 ePub `.anno-noted`
 * 的 dotted text-decoration 同一约定（见上 ANNO_IFRAME_CSS——改一侧必改另一侧）；
 * underline 样式则把实线底边换成点状（不叠两条线）。border-foreground 明暗自适应。
 */
export function overlayClass(style: AnnotationStyle, noted: boolean): string {
  if (!noted) return OVERLAY_FILL[style];
  if (style === "underline") return "border-b-2 border-dotted border-foreground/60";
  return `${OVERLAY_FILL[style]} border-b-2 border-dotted border-foreground/70`;
}
```

同时把 `ANNO_IFRAME_CSS` 的 docstring 里这行：

```
 * `.anno-noted` 叠虚线下划表示有笔记。
```

改为：

```
 * `.anno-noted` 叠虚线下划表示有笔记（与 PDF 侧 overlayClass 同一约定，改一侧必改另一侧）。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/highlight.test.ts`
Expected: PASS

- [ ] **Step 5: 三处消费点接线**

① `src/renderer/reader/apply-annotations.ts`：文件头部加 import（与既有 import 并列）：

```ts
import { hasNote } from "./highlight";
```

第 67 行：

```ts
const noted = a.note.trim().length > 0 ? " anno-noted" : "";
```

改为：

```ts
const noted = hasNote(a.note) ? " anno-noted" : "";
```

② `src/renderer/reader/pdf-annotations.ts`：文件头部加：

```ts
import { hasNote } from "./highlight";
```

`pdfAnnosByPage` 里第 58 行：

```ts
hasNote: a.note.trim().length > 0,
```

改为：

```ts
hasNote: hasNote(a.note),
```

③ `src/renderer/reader/PdfReader.tsx`：把 import 行

```ts
import { OVERLAY_FILL } from "./highlight";
```

改为：

```ts
import { overlayClass } from "./highlight";
```

PdfPage 的高亮 overlay map（约 482 行）：

```tsx
className={cn("absolute", OVERLAY_FILL[h.style])}
```

改为：

```tsx
className={cn("absolute", overlayClass(h.style, h.hasNote))}
```

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck && pnpm test src/renderer/reader`
Expected: typecheck 0 错误；reader 目录测试全绿（含既有 pdf-annotations.test.ts 等）

- [ ] **Step 7: 提交**

```bash
git add src/renderer/reader/highlight.ts src/renderer/reader/highlight.test.ts src/renderer/reader/apply-annotations.ts src/renderer/reader/pdf-annotations.ts src/renderer/reader/PdfReader.tsx
git commit -m "feat(pdf): dotted bottom-edge marker for noted PDF highlights (parity with ePub anno-noted)"
```

---

### Task 3: `nextZoom` 滚轮缩放公式

**Files:**

- Modify: `src/renderer/reader/pdf-zoom.ts`
- Test: `src/renderer/reader/pdf-zoom.test.ts`（追加 describe）

乘性缩放 `current × exp(-deltaY × SENSITIVITY)`：一档鼠标滚轮（|deltaY|≈100）≈ ±10%，与 PdfPrefs 按钮步进感受对齐；触控板捏合的小 delta 连发自然累积。**返回值不取整**（精确目标存调用方 ref，提交时才 `clampPdfZoom`），防慢速捏合被 1% 取整卡死。

- [ ] **Step 1: 写失败测试**

在 `src/renderer/reader/pdf-zoom.test.ts` 追加（import 行补 `nextZoom`）：

```ts
import { clampPdfZoom, nextZoom, PDF_ZOOM_MAX, PDF_ZOOM_MIN, PDF_ZOOM_STEP } from "./pdf-zoom";
```

```ts
describe("nextZoom", () => {
  it("一档滚轮（deltaY=-100）放大约 10%", () => {
    expect(nextZoom(1, -100)).toBeCloseTo(1.105, 2);
  });
  it("放大缩小互逆（乘性缩放）", () => {
    expect(nextZoom(nextZoom(1.3, -100), 100)).toBeCloseTo(1.3, 10);
  });
  it("慢速捏合的小 delta 不被取整卡死（返回精确值、可累积）", () => {
    let z = 1;
    for (let i = 0; i < 10; i++) z = nextZoom(z, -3);
    expect(z).toBeGreaterThan(1.02);
  });
  it("端点 clamp 到 MIN/MAX", () => {
    expect(nextZoom(4.9, -10000)).toBe(PDF_ZOOM_MAX);
    expect(nextZoom(0.3, 10000)).toBe(PDF_ZOOM_MIN);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-zoom.test.ts`
Expected: FAIL，`nextZoom` 未导出

- [ ] **Step 3: 写实现**

在 `src/renderer/reader/pdf-zoom.ts` 末尾追加：

```ts
/** 滚轮缩放灵敏度：一档鼠标滚轮（|deltaY|≈100）≈ ±10%（exp(0.1)≈1.105），与按钮步进感受对齐。 */
export const PDF_WHEEL_ZOOM_SENSITIVITY = 0.001;

/**
 * 滚轮/捏合的下一缩放值（乘性，向上滚 deltaY<0 = 放大）。返回精确值**不取整**——
 * 调用方把它存 ref 累积、提交时才过 clampPdfZoom，防慢速捏合被 1% 取整卡死。
 */
export function nextZoom(current: number, deltaY: number): number {
  const next = current * Math.exp(-deltaY * PDF_WHEEL_ZOOM_SENSITIVITY);
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, next));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-zoom.test.ts`
Expected: PASS（原 clampPdfZoom 用例 + 新 4 例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/pdf-zoom.ts src/renderer/reader/pdf-zoom.test.ts
git commit -m "feat(pdf): add nextZoom multiplicative wheel-zoom formula"
```

---

### Task 4: PdfReader 接线——进度页内精确恢复

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`

依赖 Task 1 的 `pdf-scroll.ts`。本任务把 save 端的 `scrollRatio: 0` 换成真实比例、restore 端从页级 `initialTopMostItemIndex` 换成精确 `initialScrollTop`，并把 `rangeChanged` 里散落的顶页推算公式迁移到 `topPageAt`。无法 headless 测试（Virtuoso DOM 接线），靠 typecheck + 既有测试回归 + Task 7 CDP 冒烟。

- [ ] **Step 1: 加 import**

`PdfReader.tsx` 头部（与既有 `./pdf-*` import 并列）：

```ts
import { intraPageRatio, scrollTopFor, topPageAt } from "./pdf-scroll";
```

- [ ] **Step 2: saveAt 增加 scrollRatio 参数**

把（约 223-232 行）：

```ts
const saveAt = (page: number, percent: number) => {
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = setTimeout(() => {
    const locator = makePdfLocator({ page, scrollRatio: 0 }); // 页级精度（页内比例留打磨期）
```

改为：

```ts
const saveAt = (page: number, scrollRatio: number, percent: number) => {
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = setTimeout(() => {
    const locator = makePdfLocator({ page, scrollRatio });
```

（函数体其余行不动。）

- [ ] **Step 3: rangeChanged 迁移到 topPageAt 并算页内比例**

把 `rangeChanged` 回调（约 282-315 行）里：

```ts
// rangeChanged 报告的是渲染范围——startIndex 含 increaseViewportBy 的 overscan
// 预渲染页（CDP 实测视口顶页 125 时 startIndex 报 123），直接用会把当前章/进度
// 偏到视口上方一页。从 scrollTop 推视口顶部页：每项高 pageH+16 均匀（v1 全书
// 同尺寸前提）；+8px 把页间缝隙的归属切在缝隙中点，同时吸收跨页累计的亚像素误差。
const scrollTop = scrollerRef.current?.scrollTop;
const page =
  scrollTop != null
    ? Math.min(book.pageCount, Math.max(1, Math.floor((scrollTop + 8) / (pageH + 16)) + 1))
    : range.startIndex + 1;
```

改为：

```ts
// rangeChanged 报告的是渲染范围——startIndex 含 increaseViewportBy 的 overscan
// 预渲染页（CDP 实测视口顶页 125 时 startIndex 报 123），直接用会把当前章/进度
// 偏到视口上方一页。从 scrollTop 推视口顶部页与页内比例（全书同尺寸前提，
// 几何换算见 pdf-scroll.ts）。
const scrollTop = scrollerRef.current?.scrollTop;
const page = scrollTop != null ? topPageAt(scrollTop, pageH, book.pageCount) : range.startIndex + 1;
const ratio = scrollTop != null ? intraPageRatio(scrollTop, page, pageH) : 0;
```

并把回调末尾：

```ts
saveAt(page, pdfPercent(page, book.pageCount));
```

改为：

```ts
saveAt(page, ratio, pdfPercent(page, book.pageCount));
```

- [ ] **Step 4: restore 换 initialScrollTop**

把（约 259-263 行）：

```ts
const initialPage = (() => {
  const loc = progress.data?.locator ? parsePdfLocator(progress.data.locator) : null;
  if (!loc) return 0;
  return Math.min(Math.max(loc.page - 1, 0), book.pageCount - 1);
})();
```

改为：

```ts
// 恢复位置：页 + 页内比例 → 精确 scrollTop（全书同尺寸直接算，无挂载后跳动）。
// 首页页顶特判回 0：scrollTopFor(1, 0) = 8px（py-2 上缝），别让书首露半截缝。
const initialScrollTop = (() => {
  const loc = progress.data?.locator ? parsePdfLocator(progress.data.locator) : null;
  if (!loc) return 0;
  const page = Math.min(Math.max(loc.page, 1), book.pageCount);
  const ratio = Math.min(Math.max(loc.scrollRatio, 0), 1);
  return page === 1 && ratio === 0 ? 0 : scrollTopFor(page, ratio, pageH);
})();
```

并把 Virtuoso 的 prop（约 281 行）：

```tsx
        initialTopMostItemIndex={{ index: initialPage, align: "start" }}
```

改为：

```tsx
initialScrollTop = { initialScrollTop };
```

（react-virtuoso 的 props 不接受 undefined——此处恒为 number，符合约束。）

- [ ] **Step 5: 验证**

Run: `pnpm typecheck && pnpm test src/renderer/reader && pnpm lint`
Expected: 全绿（`initialPage` 旧 IIFE 已整体替换，无未使用变量残留）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/reader/PdfReader.tsx
git commit -m "feat(pdf): precise in-page progress restore via scrollRatio"
```

---

### Task 5: PdfReader 接线——Ctrl+滚轮光标锚点缩放

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`

依赖 Task 1（几何换算）与 Task 3（nextZoom）。要点：

- React 合成 `onWheel` 是 passive 的，`preventDefault()` 拦不住浏览器整页缩放 → 原生 `addEventListener("wheel", ..., { passive: false })` 挂容器。
- `e.ctrlKey` 同时覆盖 Ctrl+滚轮与 macOS 触控板捏合（捏合 wheel 事件 ctrlKey=true）。
- 精确目标存 `zoomTargetRef`（不取整）；rAF 每帧最多提交一次 `setPdfZoom(clampPdfZoom(target))`。
- 锚点（光标处页+页内比例、横向缩放到点）存 ref，提交后 `useLayoutEffect` 复位滚动（页盒高度走内联 style、commit 即同步生效，不闪）。
- 当前 `pageW`/`pageH` 在 early-return 之后计算，而新增 hooks 必须在 early-return 之前 → 把这两个 const 上移（`book` 可能为 null，`pageH` 兜 0，效果同 early-return 守卫）。

- [ ] **Step 1: 调整 import**

`PdfReader.tsx` 第 1 行：

```ts
import { useEffect, useRef, useState } from "react";
```

改为：

```ts
import { useEffect, useLayoutEffect, useRef, useState } from "react";
```

第 19 行：

```ts
import { clampPdfZoom } from "./pdf-zoom";
```

改为：

```ts
import { clampPdfZoom, nextZoom } from "./pdf-zoom";
```

- [ ] **Step 2: 上移 pageW/pageH 计算**

删掉 early-return 之后（约 252-254 行）的：

```ts
// 页 CSS 尺寸：适宽 × 档位。
const pageW = Math.max(200, (containerW - PAGE_GUTTER) * zoom);
const pageH = pageW * (book.baseSize.height / book.baseSize.width);
```

在 hooks 区（`const setSelection = ...` 之前，约 60 行处）插入：

```ts
// 页 CSS 尺寸：适宽 × 档位。上移到 early-return 之前供缩放 hooks 使用；
// book 未就绪时 pageH=0，相关 effect 以此守卫。
const pageW = Math.max(200, (containerW - PAGE_GUTTER) * zoom);
const pageH = book ? pageW * (book.baseSize.height / book.baseSize.width) : 0;
```

- [ ] **Step 3: 加缩放 refs 与三个 effect**

在 `saveAt` 定义之后、early-return（`if (bytes.isError)`）之前插入：

```ts
const setPdfZoom = usePrefsStore((s) => s.setPdfZoom);
// Ctrl+滚轮 / 触控板捏合缩放（捏合 wheel 事件 ctrlKey=true）：精确目标存 ref
// （不过 1% 取整，防慢速捏合被取整卡死），rAF 每帧最多提交一次（页面以新分辨率
// 重挂重渲，始终锐利）。锚点 = 光标处（页, 页内比例）+ 横向缩放到点输入。
const zoomTargetRef = useRef(zoom);
const zoomAnchorRef = useRef<{
  page: number;
  ratio: number;
  cursorX: number;
  cursorY: number;
  scrollLeft: number;
  oldPageH: number;
} | null>(null);
const zoomRafRef = useRef(0);

// 外部改缩放（PdfPrefs 按钮/输入框）→ 重新 seed 精确目标；自家提交（恒 = clamp(target)）
// 不触发，保留 1% 以下精度。
useEffect(() => {
  if (Math.abs(zoom - clampPdfZoom(zoomTargetRef.current)) > 1e-6) {
    zoomTargetRef.current = zoom;
  }
}, [zoom]);

// React 合成 onWheel 是 passive 的（preventDefault 拦不住浏览器缩放）→ 原生监听。
useEffect(() => {
  const container = containerRef.current;
  if (!book || pageH <= 0 || !container) return;
  const pageCount = book.pageCount;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = container.getBoundingClientRect();
    const cursorY = e.clientY - rect.top;
    const absY = scroller.scrollTop + cursorY;
    const page = topPageAt(absY, pageH, pageCount);
    zoomTargetRef.current = nextZoom(zoomTargetRef.current, e.deltaY);
    zoomAnchorRef.current = {
      page,
      ratio: intraPageRatio(absY, page, pageH),
      cursorX: e.clientX - rect.left,
      cursorY,
      scrollLeft: scroller.scrollLeft,
      oldPageH: pageH,
    };
    if (!zoomRafRef.current) {
      zoomRafRef.current = requestAnimationFrame(() => {
        zoomRafRef.current = 0;
        setPdfZoom(clampPdfZoom(zoomTargetRef.current));
      });
    }
  };
  container.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    container.removeEventListener("wheel", onWheel);
    if (zoomRafRef.current) {
      cancelAnimationFrame(zoomRafRef.current);
      zoomRafRef.current = 0;
    }
  };
}, [book, pageH, setPdfZoom]);

// 缩放提交后复位滚动（光标锚点）：页盒高度走内联 style、commit 即同步生效 →
// useLayoutEffect 里复位不闪。竖向精确（页+页内比例反算）；横向尽力（缩放到点公式，
// 页居中↔溢出切换处略有近似）。缩放比从 pageH 实测（吸收 pageW 的 200px 下限折角）。
useLayoutEffect(() => {
  const anchor = zoomAnchorRef.current;
  const scroller = scrollerRef.current;
  if (!anchor || !scroller || pageH <= 0 || pageH === anchor.oldPageH) return;
  zoomAnchorRef.current = null;
  const scale = pageH / anchor.oldPageH;
  scroller.scrollTop = Math.max(0, scrollTopFor(anchor.page, anchor.ratio, pageH) - anchor.cursorY);
  scroller.scrollLeft = Math.max(0, (anchor.scrollLeft + anchor.cursorX) * scale - anchor.cursorX);
}, [pageH]);
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test src/renderer/reader && pnpm lint`
Expected: 全绿。注意：**别**给 onWheel 包 useCallback（React Compiler 项目约定）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/PdfReader.tsx
git commit -m "feat(pdf): ctrl+wheel / pinch zoom with cursor anchoring (rAF-throttled)"
```

---

### Task 6: 全量回归 + changeset

**Files:**

- Create: `.changeset/pdf-reading-polish.md`

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: 全绿（i18n 无新增文案，无需 extract）

- [ ] **Step 2: 写 changeset**

创建 `.changeset/pdf-reading-polish.md`：

```md
---
"marginalia": patch
---

PDF reading polish: reopening a book now restores your exact in-page scroll position (not just the page), highlights with notes show a dotted bottom edge so you can spot them at a glance, and you can zoom smoothly with Ctrl+wheel or trackpad pinch — anchored at your cursor.
```

- [ ] **Step 3: 提交**

```bash
git add .changeset/pdf-reading-polish.md
git commit -m "chore(pdf): add changeset for PDF reading polish"
```

---

### Task 7: CDP 冒烟（主会话执行，不派 subagent）

**Files:** 无代码改动（验证任务）。

前置：`pnpm start -- --remote-debugging-port=9222 --user-data-dir=/tmp/marginalia-smoke-pdf`（dev 透传 Chromium 开关恰好一个 `--`，多一个裸 `--` 会让开关静默失效）；playwright-core `connectOverCDP` 必须传 **ws URL**（从 `http://localhost:9222/json/version` 取 `webSocketDebuggerUrl`）。库里需有一本带文本层的 PDF（可拖拽导入任意本地 PDF）。

- [ ] **场景 1：页内精确恢复**——滚到某页中部 → 等 1.5s（debounce 落盘）→ 关书重开 → 截图断言落回页内原位（非页顶）。
- [ ] **场景 2：笔记记号**——划词建一条标注并写笔记、另建一条不写笔记 → 截图断言：带笔记者显点状底边线、无笔记者纯填充；切暗色模式再验一次可读。
- [ ] **场景 3：光标锚点缩放**——CDP `Input.dispatchMouseEvent(type: mouseWheel, ctrlKey)` 连发放大/缩小 → 截图断言光标下内容不漂移、页面清晰；PdfPrefs 按钮与百分比输入框仍工作；普通滚动（无 Ctrl）不受影响。
- [ ] 冒烟全过 → 不产生提交；发现 bug → 修复（走 systematic-debugging）后重验。

---

### Task 8: 收尾（finishing-a-development-branch）

- [ ] rebase 合回 main（线性历史，不要 merge commit；先 `git fetch` 看 origin/main 有无分叉）。
- [ ] 用 kanban skill 收尾：`gh issue edit 43` 勾掉 checklist 前三项（Ctrl+wheel zoom / scrollRatio restore / note markers，**不关 issue**，剩余子项保留）；卡片留 Backlog 列；评论注明本轮交付与提交号。
- [ ] 删特性分支。

---

## Self-Review 记录

- **Spec 覆盖**：§3 → Task 1+4；§4 → Task 2；§5 → Task 3+5；§6 错误边界 → Task 4 Step 4 的 clamp/特判 + Task 5 的守卫；§7 测试 → 各 task TDD 步骤 + Task 7 冒烟；§8 文件清单全部对应。无缺口。
- **占位符扫描**：所有代码步骤均给出完整代码；冒烟任务为验证性质（交互式 CDP），以验收清单表达。
- **类型一致性**：`topPageAt(y, pageH, pageCount)` / `intraPageRatio(y, page, pageH)` / `scrollTopFor(page, ratio, pageH)` / `nextZoom(current, deltaY)` / `overlayClass(style, noted)` / `hasNote(note)` 各任务间签名一致；`saveAt(page, scrollRatio, percent)` 调用点已同步。
