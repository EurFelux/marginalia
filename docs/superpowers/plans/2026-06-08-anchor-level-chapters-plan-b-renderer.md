# 锚点级章节 · Plan B（renderer / 渲染端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 渲染端按锚点工作：点章/点文内站内链接精确滚到 `#fragment` 锚点、外链开系统浏览器（顺带**修掉文内链接白屏**）、当前章高亮与进度恢复到锚点级。

**Architecture:** `SectionFrame`（epub-agnostic 包）拦截 iframe 内 `<a>` 点击、`preventDefault` 后发 `onInternalLink`/`onExternalLink` 事件给消费方（**这一步即修白屏**）；`VirtualDocs` 增 `scrollToAnchor(index, anchorId)`——`scrollToIndex` + 量 iframe 内锚点元素 offsetTop 作 virtuoso `offset`；`EpubReader` 把链接/跳章 resolve 成 (section index, anchor) 走 `scrollToAnchor`，当前章/进度读 iframe 内锚点位置定到锚点级。渲染本身（N 个 iframe）不变。

**Tech Stack:** React 19（renderer 过 React Compiler，**别手写 useCallback/useMemo**；但 `packages/virtual-docs` 不过 Compiler，包内回调仍须手动 useCallback 稳定身份）、react-virtuoso、epubjs（EpubCFI）、Electron `shell.openExternal`、Zod、vitest。

**设计依据：** `docs/superpowers/specs/2026-06-08-marginalia-anchor-level-chapters-design.md` §3.6 / §3.7 / §5；**前置 Plan A 已合入本分支**（`TocNode.anchor` / `ChapterRefDto.anchor` / 锚点章数据已就绪）。

**关键约束：**

- 当前分支 `feat/anchor-level-chapters`（已含 Plan A 的 8 个 commit）。**不要切 git 分支**。
- 测试 `pnpm test <file>`（Electron 运行时）；用 `pnpm`/`pnpx` 非 npx；pre-commit 钩子改文件需重 add + 重 commit。
- `packages/virtual-docs` 改后无需重编 better-sqlite3（纯前端包）。
- iframe/CFI/scroll 强依赖真实浏览器，**无法 headless 测**；这些任务以「纯逻辑单测 + 真书手测关卡」验证（沿用 vertical-slice §9 认可）。

---

## File Structure

| 文件                                                       | 职责                 | 改动                                                 |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `src/shared/ipc.ts`                                        | IPC 契约             | 加 `appOpenExternal` 通道 + `openExternalInput`      |
| `src/main/app/external-url.ts`（新）                       | 外链协议白名单纯函数 | `isAllowedExternalUrl(url)`                          |
| `src/main/app/external-url.test.ts`（新）                  | 单测                 | 白名单用例                                           |
| `src/main/ipc/app-handlers.ts`                             | app handler          | `bind(C.appOpenExternal, …)` + `shell.openExternal`  |
| `src/preload-api.ts`                                       | window.api           | `app.openExternal`                                   |
| `packages/virtual-docs/src/link-target.ts`（新）           | 链接分类纯函数       | `classifyLink(href)`                                 |
| `packages/virtual-docs/src/link-target.test.ts`（新）      | 单测                 | 分类用例                                             |
| `packages/virtual-docs/src/SectionFrame.tsx`               | iframe 节            | `<a>` click 拦截 + `onInternalLink`/`onExternalLink` |
| `packages/virtual-docs/src/VirtualDocs.tsx`                | 虚拟列表             | 透传链接回调 + `scrollToAnchor`                      |
| `packages/virtual-docs/src/index.ts`                       | 包导出               | 导出新类型（若有）                                   |
| `src/renderer/reader/current-anchor-chapter.ts`（新）      | 当前锚点章纯逻辑     | `pickAnchorChapter(...)`                             |
| `src/renderer/reader/current-anchor-chapter.test.ts`（新） | 单测                 | 选章用例                                             |
| `src/renderer/reader/epub-book.ts`                         | epubjs 胶水          | 锚点 offset 量取 + 锚点 CFI 辅助                     |
| `src/renderer/reader/EpubReader.tsx`                       | 接线                 | 跳章/链接/当前章/进度按锚点                          |

---

## Task 1: `app:open-external` IPC（外链开系统浏览器）

**Files:**

- Modify: `src/shared/ipc.ts`
- Create: `src/main/app/external-url.ts`, `src/main/app/external-url.test.ts`
- Modify: `src/main/ipc/app-handlers.ts`, `src/preload-api.ts`

- [ ] **Step 1: 写失败测试（协议白名单纯函数）**

`src/main/app/external-url.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./external-url";

describe("isAllowedExternalUrl", () => {
  it("allows http/https/mailto", () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com/x")).toBe(true);
    expect(isAllowedExternalUrl("mailto:a@b.com")).toBe(true);
  });
  it("rejects file/javascript/data and garbage", () => {
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<script>")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/app/external-url.test.ts`
Expected: FAIL —模块不存在。

- [ ] **Step 3: 实现纯函数**

`src/main/app/external-url.ts`：

```ts
const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/** 外链协议白名单：仅放行 http/https/mailto，拒 file/javascript/data 等（防 shell.openExternal 被滥用）。 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false; // 非法 URL
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/app/external-url.test.ts`
Expected: PASS。

- [ ] **Step 5: 加 IPC 契约**

`src/shared/ipc.ts`：在文件的 input schema 区（约 `pingInput` 附近）加：

```ts
export const openExternalInput = z.object({ url: z.string().min(1) });
export type OpenExternalInput = z.infer<typeof openExternalInput>;
```

在 `C` 对象的 `// app / ping` 段加（紧跟 `appGetLocaleSync`）：

```ts
  appOpenExternal: def("app:open-external", "invoke", openExternalInput, out<void>()),
```

- [ ] **Step 6: 加 handler**

`src/main/ipc/app-handlers.ts`：import 顶部加 `import { shell } from "electron";`（已 import `app, ipcMain`，合并为 `import { app, ipcMain, shell } from "electron";`）、`import { isAllowedExternalUrl } from "@main/app/external-url";`、`import { createLogger } from "@main/logger";`，在 `appBindings` 加：

```ts
  bind(C.appOpenExternal, (input) => {
    if (!isAllowedExternalUrl(input.url)) {
      createLogger("app").warn(`refused to open external url with disallowed protocol: ${input.url}`);
      return;
    }
    void shell.openExternal(input.url);
  }),
```

> 若文件已有模块级 `const log = createLogger("app")` 则复用 `log.warn(...)`，别重复建 logger。

- [ ] **Step 7: 暴露到 window.api**

`src/preload-api.ts` 的 `app:` namespace 加（紧跟 `openLogsDir`）：

```ts
      openExternal: inv(C.appOpenExternal),
```

- [ ] **Step 8: typecheck + 测试 + 提交**

Run: `pnpm typecheck && pnpm test src/main/app/external-url.test.ts`
Expected: 通过。

```bash
git add src/shared/ipc.ts src/main/app/external-url.ts src/main/app/external-url.test.ts src/main/ipc/app-handlers.ts src/preload-api.ts
git commit -m "feat(ipc): add app:open-external with protocol whitelist"
```

---

## Task 2: `SectionFrame` 拦截文内链接（**修白屏**）

iframe（`sandbox="allow-same-origin"` + `srcDoc`）内点 `<a href>` 会让 iframe 自身导航到无效相对地址 → 白屏。拦截 `<a>` click、`preventDefault`、按类型发事件给消费方。**这是白屏 bug 的根治。**

**Files:**

- Create: `packages/virtual-docs/src/link-target.ts`, `packages/virtual-docs/src/link-target.test.ts`
- Modify: `packages/virtual-docs/src/SectionFrame.tsx`

- [ ] **Step 1: 写失败测试（链接分类纯函数）**

`packages/virtual-docs/src/link-target.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { classifyLink } from "./link-target";

describe("classifyLink", () => {
  it("absolute http/https/mailto ⇒ external", () => {
    expect(classifyLink("https://x.com")).toEqual({ type: "external", url: "https://x.com" });
    expect(classifyLink("mailto:a@b.com")).toEqual({ type: "external", url: "mailto:a@b.com" });
  });
  it("relative path / fragment ⇒ internal (raw href)", () => {
    expect(classifyLink("text00000.html#filepos123")).toEqual({
      type: "internal",
      href: "text00000.html#filepos123",
    });
    expect(classifyLink("#filepos123")).toEqual({ type: "internal", href: "#filepos123" });
    expect(classifyLink("../ch2.xhtml")).toEqual({ type: "internal", href: "../ch2.xhtml" });
  });
  it("empty / null-ish ⇒ null (ignore)", () => {
    expect(classifyLink("")).toBeNull();
    expect(classifyLink("#")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/virtual-docs/src/link-target.test.ts`
Expected: FAIL —模块不存在。

- [ ] **Step 3: 实现分类纯函数**

`packages/virtual-docs/src/link-target.ts`：

```ts
export type LinkTarget =
  | { type: "external"; url: string }
  | { type: "internal"; href: string }
  | null;

const EXTERNAL = /^(https?:|mailto:)/i;

/** 把 iframe 内 <a href> 分类：绝对 http/https/mailto = 外链；其余（相对路径 / #fragment）= 站内；空/裸"#" = 忽略。 */
export function classifyLink(href: string): LinkTarget {
  const h = href.trim();
  if (!h || h === "#") return null;
  if (EXTERNAL.test(h)) return { type: "external", url: h };
  return { type: "internal", href: h };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test packages/virtual-docs/src/link-target.test.ts`
Expected: PASS。

- [ ] **Step 5: SectionFrame 加链接拦截**

`packages/virtual-docs/src/SectionFrame.tsx`：

(a) `Props` 接口加：

```ts
  /** 点 iframe 内站内 <a>（相对路径 / #fragment）时回调；消费方据此 resolve 到 section+anchor 跳转。 */
  onInternalLink?: (e: { index: number; href: string }) => void;
  /** 点 iframe 内外链（http/https/mailto）时回调；消费方开系统浏览器。 */
  onExternalLink?: (url: string) => void;
```

(b) 顶部 import 加：`import { classifyLink } from "./link-target";`

(c) 把这两个回调并入 `cbRef`（解构 props 时加 `onInternalLink, onExternalLink`，并加进 `cbRef.current = {...}` 两处对象）。

(d) 在 `onLoad` 内、`onAnnoClick` 监听旁，新增链接点击处理并注册/注销：

```ts
const onLinkClick = (e: MouseEvent) => {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  // 取原始 href 属性（非 a.href——后者会被 about:srcdoc 解析成绝对无效地址）。
  const raw = a.getAttribute("href") ?? "";
  const target = classifyLink(raw);
  if (!target) {
    e.preventDefault(); // 裸 "#"：阻止默认导航即可，不白屏
    return;
  }
  e.preventDefault(); // 关键：阻止 iframe 自身导航（否则白屏）
  if (target.type === "external") cbRef.current.onExternalLink?.(target.url);
  else cbRef.current.onInternalLink?.({ index, href: target.href });
};
```

注册（在现有 `doc.addEventListener("click", onAnnoClick);` 旁）：`doc.addEventListener("click", onLinkClick);`
注销（在 `detach()` 的 `doc?.removeEventListener("click", onAnnoClick);` 旁）：`doc?.removeEventListener("click", onLinkClick);`

> 注意 click 监听顺序：`onAnnoClick`（标注）与 `onLinkClick`（链接）互不干扰——标注 mark 不是 `<a>`，链接不是 `[data-anno-id]`；两者都 `closest` 各自选择器，命中才动作。

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: 通过（新 props optional，不破坏既有调用）。

- [ ] **Step 7: 提交**

```bash
git add packages/virtual-docs/src/link-target.ts packages/virtual-docs/src/link-target.test.ts packages/virtual-docs/src/SectionFrame.tsx
git commit -m "feat(virtual-docs): intercept in-frame link clicks (fix white-screen)"
```

---

## Task 3: `VirtualDocs.scrollToAnchor` + EpubReader 跳章/链接接线

让点章、点站内链接精确滚到锚点；外链开系统浏览器。

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`
- Modify: `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: VirtualDocs 透传链接回调**

`packages/virtual-docs/src/VirtualDocs.tsx`：

(a) `VirtualDocsProps` 加 `onInternalLink?` / `onExternalLink?`（签名同 SectionFrame Step 5a）。
(b) 解构 props 加这两个；在 `itemContent` 的 `<LazySection .../>` 传下去；`LazySection` 的 props 类型 + 透传到 `<SectionFrame .../>` 也补这两个。（LazySection 是中间层，照其既有「props 全量透传」模式补两个即可。）

- [ ] **Step 2: VirtualDocs 加 `scrollToAnchor`**

`packages/virtual-docs/src/VirtualDocs.tsx`：

(a) `VirtualDocsHandle` 加：

```ts
  /** 滚到第 index 个 section 内 id===anchorId 的元素处（先滚 section，待 iframe 就绪后按其 offsetTop 精确定位）。 */
  scrollToAnchor: (index: number, anchorId: string) => void;
```

(b) `useImperativeHandle` 实现（与 `scrollToIndex` 并列）。算法：先 `scrollToIndex(index)`，再 bounded retry 量 iframe 内锚点 offset 后用 virtuoso `offset` 精确定位：

```ts
      scrollToAnchor: (index: number, anchorId: string) => {
        vRef.current?.scrollToIndex({ index, align: "start" });
        let tries = 0;
        const tick = () => {
          const scroller = scrollerEl.current;
          const frame = scroller?.querySelector<HTMLIFrameElement>(
            `[data-section-index="${index}"] iframe`,
          );
          const doc = frame?.contentDocument;
          const el = doc?.getElementById(anchorId);
          // 就绪判定：iframe 已加载、锚点元素存在、文档已有高度（排版完成）。
          if (el && doc && doc.documentElement.scrollHeight > 0) {
            const offset =
              el.getBoundingClientRect().top - doc.documentElement.getBoundingClientRect().top;
            vRef.current?.scrollToIndex({ index, align: "start", offset });
            return;
          }
          if (tries++ < 20) setTimeout(tick, 50); // 上限 1s，到时放弃（已滚到 section 顶，不白屏）
        };
        setTimeout(tick, 50);
      },
```

> `scrollerEl`/`vRef` 是组件内既有 ref。virtuoso `scrollToIndex` 支持 `{ index, align, offset }`（`offset` = 距 item 起点的像素，已核 react-virtuoso 类型）。无锚点（anchorId 找不到）时退化为停在 section 顶——可接受、不白屏。

- [ ] **Step 3: EpubReader 跳章改用锚点**

`src/renderer/reader/EpubReader.tsx` 的跳章 effect（约 `:112-119`）：把 `const idx = book.indexOfHref(ch.href); if (idx >= 0) vRef.current?.scrollToIndex(idx);` 改为：

```ts
const idx = book.indexOfHref(ch.href);
if (idx < 0) return;
if (ch.anchor) vRef.current?.scrollToAnchor(idx, ch.anchor);
else vRef.current?.scrollToIndex(idx);
```

- [ ] **Step 4: EpubReader 接链接回调**

`src/renderer/reader/EpubReader.tsx`：新增两个 handler 并传给 `<VirtualDocs>`。站内链接 resolve：用 `book.indexOfHref(href)`（内部已 split 锚点取 section index）+ 从 href 取 fragment 作 anchor：

```ts
const onInternalLink = ({ index, href }: { index: number; href: string }) => {
  if (!book) return;
  const hash = href.indexOf("#");
  const anchor = hash >= 0 ? href.slice(hash + 1) : "";
  // 纯 fragment（#x，无路径）→ 当前 section 内；带路径 → resolve 到目标 section。
  const targetIdx = href.startsWith("#") ? index : book.indexOfHref(href);
  if (targetIdx < 0) {
    log.warn(`internal link target not found: ${href}`);
    return;
  }
  if (anchor) vRef.current?.scrollToAnchor(targetIdx, anchor);
  else vRef.current?.scrollToIndex(targetIdx);
};
const onExternalLink = (url: string) => {
  void window.api.app
    .openExternal({ url })
    .catch((err: unknown) => log.warn("open external failed", err));
};
```

在 `<VirtualDocs ... />` 加 props：`onInternalLink={onInternalLink}` `onExternalLink={onExternalLink}`。

> renderer 过 React Compiler，**别**给这俩 handler 包 useCallback。

- [ ] **Step 5: typecheck + 包测试**

Run: `pnpm typecheck && pnpm test packages/virtual-docs`
Expected: 通过（既有 virtual-docs 测试 + 新 link-target 测试）。

- [ ] **Step 6: 真书手测关卡（白屏 + 跳转）**

按 [[playwright-cdp-smoke]] / [[dev-cdp-smoke-args-gotcha]] 用 `pnpm start` + CDP 冒烟，或交还控制者手测。**最小验证清单**：

1. 导入/打开《早起的奇迹》（`~/Downloads/早起的奇迹…epub`），章节列表显示 61 个真实章名（Plan A 已修，复核）。
2. 点列表里「第3章」→ 视口滚到第3章对应 `#filepos` 锚点（不再停文件顶）。
3. 点正文里任意文内超链接 → **不白屏**，滚到目标锚点。
4. （若书内有外链）点外链 → 系统浏览器打开。

Expected：3 必过（白屏根治）；2 命中锚点（±一两行可接受）。若 scrollToAnchor 时序不稳（偶发停在 section 顶），调 retry 间隔/次数；**绝不**为「过」而假报。

- [ ] **Step 7: 提交**

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): jump to anchor on chapter click and in-text links"
```

---

## Task 4: 当前章高亮按锚点

滚动时把「视口顶部所在锚点章」高亮（不再恒停文件首章）。

**Files:**

- Create: `src/renderer/reader/current-anchor-chapter.ts`, `src/renderer/reader/current-anchor-chapter.test.ts`
- Modify: `src/renderer/reader/epub-book.ts`, `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: 写失败测试（选章纯逻辑）**

`src/renderer/reader/current-anchor-chapter.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { pickAnchorChapterId } from "./current-anchor-chapter";

// 入参：本 section 内的锚点章（按文档位置升序，含各自 anchor 的 offsetTop 像素）+ 视口顶在 section 内的像素位置。
const chs = [
  { id: "c1", anchor: "a1", top: 0 },
  { id: "c2", anchor: "a2", top: 500 },
  { id: "c3", anchor: "a3", top: 1200 },
];

describe("pickAnchorChapterId", () => {
  it("picks the last chapter whose anchor is at or above the viewport top", () => {
    expect(pickAnchorChapterId(chs, 0)).toBe("c1");
    expect(pickAnchorChapterId(chs, 400)).toBe("c1");
    expect(pickAnchorChapterId(chs, 500)).toBe("c2");
    expect(pickAnchorChapterId(chs, 1300)).toBe("c3");
  });
  it("empty ⇒ null", () => {
    expect(pickAnchorChapterId([], 0)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/current-anchor-chapter.test.ts`
Expected: FAIL —模块不存在。

- [ ] **Step 3: 实现纯逻辑**

`src/renderer/reader/current-anchor-chapter.ts`：

```ts
export interface AnchorChapterPos {
  id: string;
  anchor: string;
  top: number; // 该锚点元素在 section 内的 offsetTop（px）
}

/** 选「锚点 offsetTop ≤ 视口顶位置」中最靠后的章；都在下方则取第一个（section 刚进顶部）。 */
export function pickAnchorChapterId(
  chapters: AnchorChapterPos[],
  viewportTop: number,
): string | null {
  if (chapters.length === 0) return null;
  let picked = chapters[0]!.id;
  for (const c of chapters) {
    if (c.top <= viewportTop) picked = c.id;
    else break;
  }
  return picked;
}
```

- [ ] **Step 4: epub-book 暴露锚点 offset 量取**

`src/renderer/reader/epub-book.ts`：`EpubBook` 接口加方法，从已渲染的 section iframe 量各锚点 offsetTop。**注意**：epubjs 的 `section.document` 是无布局的解析树，量不到像素——必须读**真实 iframe**。故此方法由 EpubReader 传入 iframe document（或 EpubReader 直接在组件里查 DOM）。**实现选择（二选一，取简单可编译者）**：

- 方案 A（推荐）：不动 epub-book，在 EpubReader 里直接查 DOM 量取（见 Step 5）。本 Step 跳过 epub-book 改动。
- 方案 B：epub-book 加 `anchorTopsIn(doc: Document, anchors: string[]): Map<string, number>` 纯量取工具。

采用方案 A：**本 Step 无 epub-book 改动**，量取逻辑在 EpubReader（Step 5）。

- [ ] **Step 5: EpubReader 当前章接锚点**

`src/renderer/reader/EpubReader.tsx` 的 `onTopSectionChange`（约 `:146-185`）：在算出 `index` 与 `meta.scrollRatio` 后，把「当前章 = `chapterIdByHref`」升级为锚点级。新增局部量取 + 选章：

```ts
// 读该 section iframe，量本 section 内各锚点章的 offsetTop，选视口顶所在章。
const anchorChapterIdAt = (index: number): string | null => {
  const href = book?.hrefAtIndex(index);
  if (!href) return null;
  const sectionChs = chapters
    .filter((c) => c.href === href || stripFrag(c.href) === stripFrag(href))
    .filter((c) => c.anchor);
  if (sectionChs.length === 0) return chapterIdByHref(chapters, href); // 无锚点章退回 href 级
  const frame = document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
  const doc = frame?.contentDocument;
  if (!doc) return chapterIdByHref(chapters, href);
  const docTop = doc.documentElement.getBoundingClientRect().top;
  const positions = sectionChs
    .map((c) => {
      const el = c.anchor ? doc.getElementById(c.anchor) : null;
      return el
        ? { id: c.id, anchor: c.anchor!, top: el.getBoundingClientRect().top - docTop }
        : null;
    })
    .filter((x): x is { id: string; anchor: string; top: number } => x !== null)
    .sort((a, b) => a.top - b.top);
  const sectionHeight = book?.textLengthAtIndex(index) ? doc.documentElement.scrollHeight : 0;
  const viewportTop = sectionHeight * meta.scrollRatio;
  return pickAnchorChapterId(positions, viewportTop) ?? chapterIdByHref(chapters, href);
};
```

把原 `const chId = href ? chapterIdByHref(chapters, href) : null;` 改为 `const chId = anchorChapterIdAt(index);`。其余（`setReadingContext` / `setCurrentChapter` / 进度）逻辑不变。

辅助 `stripFrag`（文件内或从 `chapter-id-by-href.ts` 导出复用）：`const stripFrag = (h: string) => h.split("#")[0]!;`

> import 顶部加 `import { pickAnchorChapterId } from "./current-anchor-chapter";`。renderer 过 Compiler，别加 useCallback。

- [ ] **Step 6: typecheck + 单测**

Run: `pnpm typecheck && pnpm test src/renderer/reader/current-anchor-chapter.test.ts`
Expected: 通过。

- [ ] **Step 7: 真书手测关卡**

`pnpm start` 打开《早起的奇迹》，缓慢滚动正文：左侧章节列表高亮应**随滚动逐章下移**（不再恒停文件首章）。允许有一两行的边界误差。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/reader/current-anchor-chapter.ts src/renderer/reader/current-anchor-chapter.test.ts src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): highlight current chapter at anchor granularity"
```

---

## Task 5: 进度恢复到锚点（CFI）

存进度时用「视口顶部元素」的 CFI（而非恒 section 起点），恢复时滚到该 CFI 对应锚点。

**Files:**

- Modify: `src/renderer/reader/epub-book.ts`, `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: epub-book 加「视口顶元素 CFI」**

`src/renderer/reader/epub-book.ts`：`EpubBook` 接口加（并在 `createEpubBook` 返回对象实现）：

```ts
/** 给定 section 文档与其内某元素，算该元素起点 CFI（进度锚点级存储）。失败返回 null。 */
cfiFromElement: (index: number, el: Element) => string | null;
```

实现（仿 `cfiAtIndex`，用 `EpubCFI` 构造器 + `ANNO_IGNORE_CLASS`）：

```ts
    cfiFromElement: (index, el) => {
      const s = sectionAt(index);
      if (!s) return null;
      try {
        return new EpubCFI(el, s.cfiBase, ANNO_IGNORE_CLASS).toString();
      } catch {
        return null;
      }
    },
```

- [ ] **Step 2: EpubReader 存进度用顶元素 CFI**

`src/renderer/reader/EpubReader.tsx` 的 `onTopSectionChange`：把 `const cfi = book.cfiAtIndex(index);` 升级——优先用视口顶锚点章的元素算 CFI，取不到退回 `cfiAtIndex(index)`：

```ts
const topAnchorCfi = (index: number, chId: string | null): string => {
  const sectionFallback = book!.cfiAtIndex(index) ?? "";
  if (!chId) return sectionFallback;
  const ch = chapters.find((c) => c.id === chId);
  if (!ch?.anchor) return sectionFallback;
  const frame = document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
  const el = frame?.contentDocument?.getElementById(ch.anchor);
  if (!el) return sectionFallback;
  return book!.cfiFromElement(index, el) ?? sectionFallback;
};
```

把 `const cfi = book.cfiAtIndex(index);` 改为 `const cfi = topAnchorCfi(index, /* 见下 */ chId);`——注意 `chId` 在该函数后面才算出，需把 `chId` 计算上移到 `cfi` 之前。调整顺序：先算 `chId = anchorChapterIdAt(index)`，再 `const cfi = topAnchorCfi(index, chId);`，其余不变。

> 恢复路径（`:121-128` `initialIndex` 用 `book.indexOfCfi(locator)`）已能从锚点 CFI 取回 section index（`EpubCFI.spinePos`）。**section 级恢复已够**（落到正确 section 顶）；若要恢复到锚点精确位置，是 nice-to-have——本 Plan 接受恢复到 section 顶（locator 仍存锚点 CFI 供未来精确恢复）。**不强求** initialIndex 精确到锚点。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: 真书手测关卡**

打开《早起的奇迹》滚到中部某章 → 关闭/重开书 → 恢复到该章所在 section（顶元素 CFI 已存）。验证不回到全书开头。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/epub-book.ts src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): store progress CFI at viewport-top anchor"
```

---

## Task 6: changeset + 全量验证

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿（pdf-parser 的 `vitest.setup.ts` 失败是 pre-existing 无关问题，忽略）。

- [ ] **Step 2: changeset**

`.changeset/anchor-chapters-renderer.md`：

```md
---
"marginalia": minor
---

ePub reader now navigates at anchor granularity: clicking a chapter or an in-text link scrolls to the exact #fragment anchor, external links open in the system browser, and current-chapter highlight follows the anchor you're reading. Fixes a white screen when clicking in-text hyperlinks (the sandboxed iframe used to navigate itself to an invalid URL).
```

- [ ] **Step 3: 提交**

```bash
git add .changeset
git commit -m "docs: changeset for anchor-level chapters (renderer)"
```

---

## Self-Review 检查记录

- **Spec 覆盖**：§3.7 open-external(T1) · §3.6 链接拦截/修白屏(T2) · scrollToAnchor + 跳章/链接接线(T3) · 当前章锚点级(T4) · 进度锚点 CFI(T5)。
- **白屏根治**在 T2（preventDefault 拦截 `<a>`）——即使 T3 scrollToAnchor 时序不完美，白屏也已消除。
- **可测 vs 手测**：纯函数（`isAllowedExternalUrl`/`classifyLink`/`pickAnchorChapterId`）单测；iframe/scroll/CFI 真书手测（关卡明确，禁假报）。
- **类型一致**：`onInternalLink: (e:{index:number;href:string})=>void` 与 `onExternalLink:(url:string)=>void` 在 SectionFrame/VirtualDocs/EpubReader 三处一致；`scrollToAnchor(index,anchorId)` 在 Handle 定义与 EpubReader 调用一致；`ChapterRefDto.anchor`（Plan A 已加）在 T4/T5 消费。
- **React Compiler**：renderer 不手写 useCallback；`packages/virtual-docs` 不过 Compiler，新增包内回调若传给 virtuoso 子树须手动 useCallback 稳定（T3 的 onInternalLink/onExternalLink 经 props 透传到 LazySection，沿用既有透传模式即可）。

---

## Execution Handoff

全部 Task 完成且真书手测通过后，本功能（锚点级章节，Plan A + B）整体完成 → `superpowers:finishing-a-development-branch` 收尾（合并 `feat/anchor-level-chapters` 入 main，按 [[local-main-rebase-linear-workflow]] rebase 保线性；用 `kanban` skill 检查有无可 close 的 issue）。
