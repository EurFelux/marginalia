# RA1-full · Plan A：`@marginalia/virtual-docs` 包 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 造一个 **epub-agnostic** 的 workspace 包 `@marginalia/virtual-docs`——薄封装 react-virtuoso 做「变高文档连续滚动虚拟化」，每项是一个**按内容自适应高度的 iframe**，对外发**选区事件**（含 viewport 坐标 + range + doc）。在 ui-prototype 用合成数据独立验证。

**Architecture:** 虚拟化（窗口/测量/锚定）全交给 **react-virtuoso**；我们只写薄胶水：`SectionFrame`（iframe `srcdoc` 注入 HTML + `ResizeObserver` 自适应高度 + 选区监听 + 样式注入）、`VirtualDocs`（Virtuoso 包装 + 异步 `loadSection` + `rangeChanged`→top index + `ref.scrollToIndex`）。包**不知 epub/CFI**——消费方（Plan B 的 app / 本计划的 prototype）喂 `loadSection(i)→html`、消费 `onSelect`。坐标平移抽成纯函数 headless 测；iframe/虚拟化行为靠 prototype 手测。

**Tech Stack:** React 19 + react-virtuoso（v4）+ TypeScript 6（strict）+ vitest 4。workspace 源码包（仿 `@marginalia/epub-parser`，无构建步骤，`main→src/index.ts`）。

**ABI 提示（执行者必读）：** 装 `react-virtuoso` 会让 `pnpm install` 把 better-sqlite3 重编为 Node ABI（137）。装完**必须** `pnpm db:rebuild:electron` 翻回 Electron ABI（145），否则 `pnpm test` 加载 better-sqlite3 失败。本包自身测试不碰 better-sqlite3，但根 `pnpm test` 跑全量会碰。

---

## 文件结构

| 文件                                             | 责任                                                         | 改动   |
| ------------------------------------------------ | ------------------------------------------------------------ | ------ |
| `packages/virtual-docs/package.json`             | 包清单（名/类型/exports/deps）                               | Create |
| `packages/virtual-docs/tsconfig.json`            | 包 tsconfig（jsx + DOM lib，仿 epub-parser）                 | Create |
| `packages/virtual-docs/vitest.config.ts`         | 包 vitest 配置（仿 epub-parser）                             | Create |
| `packages/virtual-docs/src/geometry.ts`          | 纯函数 `toViewportRect`（iframe 内 rect → viewport）         | Create |
| `packages/virtual-docs/src/geometry.test.ts`     | headless 单测                                                | Create |
| `packages/virtual-docs/src/SectionFrame.tsx`     | 自适应高度 iframe + 选区事件 + 样式注入                      | Create |
| `packages/virtual-docs/src/VirtualDocs.tsx`      | Virtuoso 包装 + 异步 loadSection + top index + scrollToIndex | Create |
| `packages/virtual-docs/src/index.ts`             | 公开导出                                                     | Create |
| `packages/ui-prototype/vite.config.ts`           | 加 `@marginalia/virtual-docs` 源码别名                       | Modify |
| `packages/ui-prototype/src/routes/vdocs-lab.tsx` | 合成数据实验页                                               | Create |

---

## Task 1: 创建 workspace 包骨架 + 装 react-virtuoso

**Files:**

- Create: `packages/virtual-docs/package.json`
- Create: `packages/virtual-docs/tsconfig.json`
- Create: `packages/virtual-docs/vitest.config.ts`
- Create: `packages/virtual-docs/src/index.ts`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "@marginalia/virtual-docs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "typescript": "~6.0.3",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**（仿 epub-parser，加 jsx + DOM lib）

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": ["react", "react-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 4: 写占位 `src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: 注册包 + 装 react-virtuoso + 翻 ABI**

```bash
pnpm install
pnpm --filter @marginalia/virtual-docs add react-virtuoso
pnpm db:rebuild:electron
```

Expected: `pnpm install` 把新包纳入 workspace；`add` 把 `react-virtuoso` 写进包 `dependencies` 并安装；`db:rebuild:electron` 完成（`✔ Rebuild Complete`）。

- [ ] **Step 6: 验证 ABI 已翻回 + 包 typecheck**

Run: `pnpm test 2>&1 | tail -3 && pnpm --filter @marginalia/virtual-docs typecheck`
Expected: 根全量测试通过（证明 better-sqlite3 ABI 已回 145）；包 typecheck 无错误。

- [ ] **Step 7: Commit**

```bash
git add packages/virtual-docs package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(virtual-docs): scaffold workspace package with react-virtuoso"
```

---

## Task 2: `toViewportRect` 纯函数（坐标平移，headless 测）

**Files:**

- Create: `packages/virtual-docs/src/geometry.ts`
- Test: `packages/virtual-docs/src/geometry.test.ts`

> iframe 内的选区 rect 是 iframe 局部坐标，要加 iframe 在主视口的偏移才是 viewport 坐标。抽成纯函数：① 可 headless 测（不依赖 DOM/`DOMRect`）② 产出 `{x,y,width,height}` 形状**与 `SelectionInfo.rect` 一致**（Plan B 直接喂 store）。

- [ ] **Step 1: 写失败测试**

`packages/virtual-docs/src/geometry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { toViewportRect } from "./geometry";

describe("toViewportRect", () => {
  it("adds the iframe's viewport offset to the in-iframe rect", () => {
    const r = toViewportRect({ left: 10, top: 20, width: 5, height: 8 }, { left: 100, top: 200 });
    expect(r).toEqual({ x: 110, y: 220, width: 5, height: 8 });
  });

  it("handles zero offset", () => {
    const r = toViewportRect({ left: 3, top: 4, width: 1, height: 2 }, { left: 0, top: 0 });
    expect(r).toEqual({ x: 3, y: 4, width: 1, height: 2 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @marginalia/virtual-docs test`
Expected: FAIL（`toViewportRect` 模块/导出不存在）。

- [ ] **Step 3: 实现 `geometry.ts`**

```ts
/** 选区 viewport 坐标矩形（形状对齐渲染层 SelectionInfo.rect）。 */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 把 iframe 内坐标的 rect 平移为主视口坐标（加 iframe 在视口的左上偏移）。 */
export function toViewportRect(
  rangeRect: { left: number; top: number; width: number; height: number },
  iframeRect: { left: number; top: number },
): ViewportRect {
  return {
    x: rangeRect.left + iframeRect.left,
    y: rangeRect.top + iframeRect.top,
    width: rangeRect.width,
    height: rangeRect.height,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @marginalia/virtual-docs test`
Expected: PASS（2 用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/virtual-docs/src/geometry.ts packages/virtual-docs/src/geometry.test.ts
git commit -m "feat(virtual-docs): add toViewportRect pure helper"
```

---

## Task 3: `SectionFrame`（自适应高度 iframe + 选区事件 + 样式注入）

**Files:**

- Create: `packages/virtual-docs/src/SectionFrame.tsx`

> 单项 = 一个 iframe：`srcdoc` 注入（资源已解析的）HTML + 偏好 `<style>`；`sandbox="allow-same-origin"` 禁脚本（ePub JS 默认关；allow-same-origin 供测量/选区/blob 资源）。load 后 ① 设 `iframe.style.height = contentDocument.documentElement.scrollHeight` 并用 `ResizeObserver` 跟随（virtuoso 据此测外层、做窗口/锚定）② 挂 `mouseup`/`selectionchange` 发选区事件（rect 经 `toViewportRect` 平移）。`srcDoc` 随 `html`/`styleCss` memo——改 `styleCss` 会重载 iframe（偏好变更不频繁，可接受；如手测发现抖动明显，后续改为热更新注入 style，本计划先用最简版）。纯 DOM 组件，靠 prototype 手测（Task 5）。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useMemo, useRef } from "react";
import { toViewportRect, type ViewportRect } from "./geometry";

export interface SectionSelectEvent {
  index: number;
  range: Range;
  doc: Document;
  rect: ViewportRect;
  text: string;
}

interface Props {
  index: number;
  html: string;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
}

const STYLE_ID = "vd-style";

/** 把（可能是片段或完整文档的）HTML 包成带注入 style 的完整文档串。 */
function buildSrcDoc(html: string, styleCss?: string): string {
  const style = `<style id="${STYLE_ID}">${styleCss ?? ""}</style>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

export function SectionFrame({ index, html, styleCss, onSelect, onSelectionCleared }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 用 ref 持最新回调，避免回调身份变化触发 effect 重挂
  const cbRef = useRef({ onSelect, onSelectionCleared });
  cbRef.current = { onSelect, onSelectionCleared };

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    let doc: Document | null = null;

    const onMouseUp = () => {
      if (!doc) return;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      const fr = iframe.getBoundingClientRect();
      cbRef.current.onSelect?.({ index, range, doc, rect: toViewportRect(r, fr), text });
    };
    const onSelChange = () => {
      if (!doc) return;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed) cbRef.current.onSelectionCleared?.();
    };
    const detach = () => {
      ro?.disconnect();
      ro = undefined;
      doc?.removeEventListener("mouseup", onMouseUp);
      doc?.removeEventListener("selectionchange", onSelChange);
      doc = null;
    };
    const onLoad = () => {
      detach();
      doc = iframe.contentDocument;
      if (!doc) return;
      const measure = () => {
        if (doc) iframe.style.height = `${doc.documentElement.scrollHeight}px`;
      };
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(doc.documentElement);
      doc.addEventListener("mouseup", onMouseUp);
      doc.addEventListener("selectionchange", onSelChange);
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      detach();
    };
  }, [index]);

  const srcDoc = useMemo(() => buildSrcDoc(html, styleCss), [html, styleCss]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      title={`section-${index}`}
      scrolling="no"
      style={{ width: "100%", border: 0, display: "block" }}
    />
  );
}
```

- [ ] **Step 2: 包 typecheck**

Run: `pnpm --filter @marginalia/virtual-docs typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add packages/virtual-docs/src/SectionFrame.tsx
git commit -m "feat(virtual-docs): add auto-height SectionFrame with selection events"
```

---

## Task 4: `VirtualDocs`（Virtuoso 包装）+ 公开导出

**Files:**

- Create: `packages/virtual-docs/src/VirtualDocs.tsx`
- Modify: `packages/virtual-docs/src/index.ts`

> Virtuoso 管虚拟化；`itemContent(i)` 渲一个 `LazySection`（异步 `loadSection(i)` 拿 HTML，加载中占位）→ `SectionFrame`。`rangeChanged({startIndex})` → `onTopIndexChange`（用作当前章/进度；注意 overscan 下 startIndex 可能略高于视口顶，对进度/当前章足够）。`ref` 暴露 `scrollToIndex`。**不暴露 estimateHeight**：virtuoso 自动测量（YAGNI；如初始抖动明显，后续可加 `defaultItemHeight`）。

- [ ] **Step 1: 写组件**

```tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";

export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
}

export interface VirtualDocsProps {
  count: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  initialIndex?: number;
  onTopIndexChange?: (index: number) => void;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
}

export const VirtualDocs = forwardRef<VirtualDocsHandle, VirtualDocsProps>(function VirtualDocs(
  { count, loadSection, styleCss, initialIndex, onTopIndexChange, onSelect, onSelectionCleared },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => vRef.current?.scrollToIndex({ index, align: "start" }),
    }),
    [],
  );

  const itemContent = useCallback(
    (index: number) => (
      <LazySection
        index={index}
        loadSection={loadSection}
        styleCss={styleCss}
        onSelect={onSelect}
        onSelectionCleared={onSelectionCleared}
      />
    ),
    [loadSection, styleCss, onSelect, onSelectionCleared],
  );

  return (
    <Virtuoso
      ref={vRef}
      style={{ height: "100%" }}
      totalCount={count}
      initialTopMostItemIndex={initialIndex}
      itemContent={itemContent}
      rangeChanged={({ startIndex }) => onTopIndexChange?.(startIndex)}
    />
  );
});

function LazySection({
  index,
  loadSection,
  styleCss,
  onSelect,
  onSelectionCleared,
}: {
  index: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadSection(index)
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml("<p>（本节加载失败）</p>"));
    return () => {
      alive = false;
    };
  }, [index, loadSection]);

  if (html == null) return <div style={{ minHeight: 200 }} />;
  return (
    <SectionFrame
      index={index}
      html={html}
      styleCss={styleCss}
      onSelect={onSelect}
      onSelectionCleared={onSelectionCleared}
    />
  );
}
```

- [ ] **Step 2: 写 `src/index.ts` 导出**

```ts
export { VirtualDocs } from "./VirtualDocs";
export type { VirtualDocsHandle, VirtualDocsProps } from "./VirtualDocs";
export type { SectionSelectEvent } from "./SectionFrame";
export type { ViewportRect } from "./geometry";
```

- [ ] **Step 3: 包 typecheck + 测试**

Run: `pnpm --filter @marginalia/virtual-docs typecheck && pnpm --filter @marginalia/virtual-docs test`
Expected: typecheck 无错误；测试 PASS（geometry 2 用例）。

- [ ] **Step 4: Commit**

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx packages/virtual-docs/src/index.ts
git commit -m "feat(virtual-docs): add VirtualDocs virtuoso wrapper and exports"
```

---

## Task 5: ui-prototype 实验页（合成数据）+ 手测检查点

**Files:**

- Modify: `packages/ui-prototype/vite.config.ts`
- Create: `packages/ui-prototype/src/routes/vdocs-lab.tsx`

> ui-prototype 是**隔离**的（独立 lock，不在 workspace）。要消费包源码需：① 装 react-virtuoso 到原型自己的 node_modules（`--ignore-workspace`，否则污染根 lock + 两份 React，见记忆 `ui-prototype-dep-install-gotcha`）② Vite `resolve.alias` 指向包源码。用 TanStack Router 文件路由加一个实验页，喂合成变高 section（不同长度 lorem + 一张图）。

- [ ] **Step 1: 给原型装 react-virtuoso（隔离）**

```bash
cd packages/ui-prototype && pnpm add --ignore-workspace react-virtuoso && cd ../..
```

Expected: 写进 `packages/ui-prototype/package.json` 与其**独立** lock；不动根 lock。

- [ ] **Step 2: 加包源码别名到 `packages/ui-prototype/vite.config.ts`**

在 `import` 区加 `import path from "node:path";`，并把 `resolve` 改为：

```ts
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@marginalia/virtual-docs": path.resolve(__dirname, "../virtual-docs/src/index.ts"),
    },
  },
```

- [ ] **Step 3: 写实验页 `packages/ui-prototype/src/routes/vdocs-lab.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";

export const Route = createFileRoute("/vdocs-lab")({
  component: VDocsLab,
});

// 合成变高 section：不同段数的 lorem + 第 3 节插一张图
const COUNT = 200;
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

function makeHtml(i: number): string {
  const paras = 3 + (i % 7); // 3~9 段，制造变高
  const body = Array.from(
    { length: paras },
    (_, p) => `<p>[${i}.${p}] ${LOREM.repeat(2 + (p % 3))}</p>`,
  ).join("");
  const img =
    i % 5 === 3
      ? `<img src="https://placehold.co/600x300?text=section+${i}" style="max-width:100%"/>`
      : "";
  return `<h2>Section ${i}</h2>${img}${body}`;
}

function VDocsLab() {
  const ref = useRef<VirtualDocsHandle | null>(null);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #ccc", display: "flex", gap: 8 }}>
        <button onClick={() => ref.current?.scrollToIndex(0)}>顶部</button>
        <button onClick={() => ref.current?.scrollToIndex(100)}>跳到 100</button>
        <button onClick={() => ref.current?.scrollToIndex(COUNT - 1)}>末尾</button>
        <span id="top-index">top: ?</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VirtualDocs
          ref={ref}
          count={COUNT}
          loadSection={async (i) => makeHtml(i)}
          styleCss="body{font-family:sans-serif;line-height:1.6;max-width:680px;margin:0 auto;padding:16px}"
          onTopIndexChange={(i) => {
            const el = document.getElementById("top-index");
            if (el) el.textContent = `top: ${i}`;
          }}
          onSelect={(e) =>
            console.log("selected", e.index, JSON.stringify(e.rect), e.text.slice(0, 40))
          }
          onSelectionCleared={() => console.log("selection cleared")}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 原型 typecheck**

Run: `cd packages/ui-prototype && pnpm exec tsc --noEmit; cd ../..`
Expected: 无错误（路由树 `routeTree.gen.ts` 由 router 插件在 dev/build 时生成；若 typecheck 因未生成路由类型报该路由相关错，先跑一次 `pnpm --filter-free` dev 生成后再查，或忽略仅该 gen 警告——以 Step 5 手测为准）。

- [ ] **Step 5: Commit**

```bash
git add packages/ui-prototype/vite.config.ts packages/ui-prototype/src/routes/vdocs-lab.tsx packages/ui-prototype/package.json packages/ui-prototype/pnpm-lock.yaml
git commit -m "feat(ui-prototype): add virtual-docs experiment lab route"
```

- [ ] **Step 6: 【手测检查点 · 包验证】**

> ⚠️ 由人执行。subagent 在此停下并提示。

```bash
cd packages/ui-prototype && pnpm dev
```

打开 `http://localhost:3000/vdocs-lab`，验收：

- **连续滚动**：上下滚动顺滑，每节真实渲染（含第 5n+3 节的图片）。
- **iframe 自适应高度**：每节高度贴合内容、无内部滚动条、无大片空白或截断。
- **向上滚不跳（关键）**：快速滚到中部再往回滚，内容**不跳变/不闪**（react-virtuoso 锚定）。
- **内存有界**：DevTools → Elements，滚动时 DOM 里 iframe 数量维持小窗口（不随滚动累积到 200）；Performance/Memory 不无界增长。
- **跳转**：点「跳到 100」「末尾」「顶部」能正确定位。
- **top index**：滚动时顶部计数随视口顶部 section 更新。
- **选区事件**：在某节正文划选 → Console 打出 `selected <index> <rect> <text>`，且 `rect` 的 x/y 与选区在**整页**中的视觉位置吻合（不是 iframe 局部坐标）。划空/点别处 → `selection cleared`。

> 这一步是本包的核心验证。若「向上滚跳变」或「iframe 高度不准」明显，记录现象——多半在 `SectionFrame` 的测量时机或 `styleCss` 重载策略，按现象微调后重测（这正是把包独立出来、先用合成数据实验的目的）。

---

## 完成后

- 全部 5 任务过 + 手测检查点通过后，`@marginalia/virtual-docs` 即为**独立可用、已验证**的虚拟化文档组件。
- 本计划 commit 直接进 `main`（纯新增包 + 原型实验，低风险；如需走 PR 按你们流程）。
- 接 **Plan B：RA1-full app 集成**——`readEpubBytes` IPC + epub.js 胶水（`ePub`/`section.load`/`EpubCFI`）+ `EpubReader` 替换 ReaderPane + CFI 进度/跳章/当前章 + 偏好注入 + 选区桥（消费本包 `onSelect`）+ 删 ReaderPane/useSelection。Plan B 据**本包验证后的真实 API**精确编写。

## 刻意推迟（不在本计划）

- 包的 `estimateHeight`/`defaultItemHeight`（virtuoso 自动测量够用；初始抖动明显再加）。
- `styleCss` 热更新注入（先用 srcDoc 重载；prefs 变更抖动明显再优化）。
- 子 section 切块（超大单节）——见 spec §8。
- 任何 epub/CFI 逻辑（属 Plan B / 消费方）。
