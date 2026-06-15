# ePub 标注 anchor 级章节归属 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让侧栏 ePub 标注对「单文件 + 锚点切章」的书（共享 href 的锚点章）也显示正确锚点章，而非退化为空。

**Architecture:** `chapterIdAtCfi` 升级为两级归属（href 唯一→直接返回；共享 href→用预计算的锚点边界 CFI 经 `EpubCFI.compare` 细分）。锚点边界 CFI 由 `epub-session` 在开书后异步预计算（渲染共享 href 的 section、`epub-book.anchorCfi` 生成），经 context 暴露给侧栏同步消费。未就绪/失败优雅退化到 href 级。

**Tech Stack:** React 19 (+ React Compiler)、@tanstack/react-query、epubjs（`EpubCFI.compare` / `cfiFromElement`）、vitest、TypeScript strict。

**前置事实（已实测）：** `EpubCFI.compare(a,b)` 返回 -1/0/1（标准 comparator，同 section 按元素路径，range vs point 可比）；`new EpubCFI(cfi).spinePos` 对 `/6/N` 为 `N/2-1`、无效串构造即抛。本轮在 `fix/epub-annotation-chapter-attribution` 分支续作（href 级修复已在该分支）。

---

## Task 1: 抽 `chaptersMatchingHref`（TDD）

**Files:** Modify `src/renderer/reader/chapter-id-by-href.ts`、`src/renderer/reader/chapter-id-by-href.test.ts`

- [ ] **Step 1: 追加失败测试**（在现有 `chapter-id-by-href.test.ts` 末尾，import 增 `chaptersMatchingHref`）

```ts
describe("chaptersMatchingHref", () => {
  it("returns the single exact match", () => {
    expect(chaptersMatchingHref(chapters, "text/chap1.xhtml").map((c) => c.id)).toEqual(["id-c1"]);
  });
  it("returns ALL chapters sharing one href (anchor chapters)", () => {
    const shared: ChapterRefDto[] = [
      {
        id: "a",
        title: "A",
        href: "text/all.html",
        anchor: "p1",
        orderIndex: 0,
        level: 0,
        startPage: null,
        endPage: null,
      },
      {
        id: "b",
        title: "B",
        href: "text/all.html",
        anchor: "p2",
        orderIndex: 1,
        level: 0,
        startPage: null,
        endPage: null,
      },
      {
        id: "c",
        title: "C",
        href: "text/all.html",
        anchor: "p3",
        orderIndex: 2,
        level: 0,
        startPage: null,
        endPage: null,
      },
    ];
    expect(chaptersMatchingHref(shared, "text/all.html").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("falls back to basename matches", () => {
    expect(chaptersMatchingHref(chapters, "OEBPS/text/chap1.xhtml").map((c) => c.id)).toEqual([
      "id-c1",
    ]);
  });
  it("returns empty when nothing matches", () => {
    expect(chaptersMatchingHref(chapters, "missing.xhtml")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试看失败** — `pnpm test src/renderer/reader/chapter-id-by-href.test.ts` → FAIL（`chaptersMatchingHref` 未导出）。

- [ ] **Step 3: 实现** — 把 `chapter-id-by-href.ts` 改为（`basename` 改 export 供后续复用；`chapterIdByHref` 复用 `chaptersMatchingHref`，行为对「同 href 多 exact」从「取第一个」变「null」，更合理、现有用例不受影响）：

```ts
import type { ChapterRefDto } from "@shared/library";

function stripFragment(href: string): string {
  return href.split("#")[0]!.split("?")[0]!;
}

/** 取末段文件名（路径前缀不一致时的兜底匹配）。 */
export function basename(href: string): string {
  const p = stripFragment(href);
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * href → 匹配的章列表：先 exact（去 fragment）命中则返回全部 exact；否则返回全部 basename 命中。
 * 同 href 多章（锚点切章）会返回多项，供调用方做 anchor 级细分。
 */
export function chaptersMatchingHref(chapters: ChapterRefDto[], href: string): ChapterRefDto[] {
  const target = stripFragment(href);
  const exact = chapters.filter((c) => stripFragment(c.href) === target);
  if (exact.length > 0) return exact;
  const base = basename(href);
  return chapters.filter((c) => basename(c.href) === base);
}

/** spine 项 href → 唯一章节 id；歧义（多命中）或无命中返回 null。 */
export function chapterIdByHref(chapters: ChapterRefDto[], href: string): string | null {
  const m = chaptersMatchingHref(chapters, href);
  return m.length === 1 ? m[0]!.id : null;
}
```

- [ ] **Step 4: 跑测试** — `pnpm test src/renderer/reader/chapter-id-by-href.test.ts` → PASS（新旧用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/chapter-id-by-href.ts src/renderer/reader/chapter-id-by-href.test.ts
git commit -m "refactor(reader): extract chaptersMatchingHref for multi-match href lookup"
```

（pre-commit 钩子改文件而中止时，重新 `git add` 再执行同一 commit。message 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。）

---

## Task 2: `chapterIdAtCfi` 升级两级归属（TDD）

**Files:** Modify `src/renderer/reader/chapter-id-at-cfi.ts`、`src/renderer/reader/chapter-id-at-cfi.test.ts`

- [ ] **Step 1: 追加失败测试**（import 增 `type AnchorBoundary`；现有用例不传第 4 参仍走 href 级、保持通过）

```ts
describe("chapterIdAtCfi anchor-level", () => {
  const sharedHrefs = ["text/all.html"]; // 单 spine
  const sharedChapters: ChapterRefDto[] = [
    {
      id: "c1",
      title: "C1",
      href: "text/all.html",
      anchor: "p1",
      orderIndex: 0,
      level: 0,
      startPage: null,
      endPage: null,
    },
    {
      id: "c2",
      title: "C2",
      href: "text/all.html",
      anchor: "p2",
      orderIndex: 1,
      level: 0,
      startPage: null,
      endPage: null,
    },
    {
      id: "c3",
      title: "C3",
      href: "text/all.html",
      anchor: "p3",
      orderIndex: 2,
      level: 0,
      startPage: null,
      endPage: null,
    },
  ];
  // 边界 CFI 升序：c1@/4/10, c2@/4/100, c3@/4/200
  const boundaries: AnchorBoundary[] = [
    { chapterId: "c1", cfi: "epubcfi(/6/2!/4/10/1:0)" },
    { chapterId: "c2", cfi: "epubcfi(/6/2!/4/100/1:0)" },
    { chapterId: "c3", cfi: "epubcfi(/6/2!/4/200/1:0)" },
  ];

  it("subdivides a shared href to the right anchor chapter", () => {
    // 标注在 /4/150（c2 与 c3 之间）→ c2
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/150,/1:0,/1:5)", boundaries),
    ).toBe("c2");
    // 标注在 /4/5（首个边界之前）→ null
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/5,/1:0,/1:5)", boundaries),
    ).toBeNull();
    // 标注在 /4/250（最后边界之后）→ c3
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/250,/1:0,/1:5)", boundaries),
    ).toBe("c3");
  });

  it("falls back to null when boundaries are not ready (shared href, empty boundaries)", () => {
    expect(
      chapterIdAtCfi(sharedChapters, sharedHrefs, "epubcfi(/6/2!/4/150,/1:0,/1:5)", []),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试看失败** — `pnpm test src/renderer/reader/chapter-id-at-cfi.test.ts` → FAIL（`AnchorBoundary` 未导出 / 第 4 参未支持）。

- [ ] **Step 3: 实现** — 把 `chapter-id-at-cfi.ts` 改为：

```ts
import { EpubCFI } from "epubjs";
import type { ChapterRefDto } from "@shared/library";
import { chaptersMatchingHref } from "./chapter-id-by-href";

/** 共享 href 锚点章的边界：该章起点元素的 CFI。anchorBoundaries 按 cfi 升序排列。 */
export interface AnchorBoundary {
  chapterId: string;
  cfi: string;
}

/**
 * ePub 标注/位置 CFI → 章节 id（与 PDF chapterIdAtPage 对称）。
 * 两级：spinePos→href 唯一章直接返回；共享 href（锚点切章）用 anchorBoundaries 经 EpubCFI.compare 细分。
 * anchorBoundaries 未就绪/无该 href 边界 → null（退化，宁可不显示不错章）。
 */
export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
  anchorBoundaries: AnchorBoundary[] = [],
): string | null {
  let pos: number;
  try {
    pos = new EpubCFI(cfi).spinePos ?? -1;
  } catch {
    return null;
  }
  const href = pos >= 0 ? spineHrefs[pos] : undefined;
  if (!href) return null;

  const matches = chaptersMatchingHref(chapters, href);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.id;

  // 共享 href（锚点切章）→ anchor 级细分
  const ids = new Set(matches.map((c) => c.id));
  const relevant = anchorBoundaries.filter((b) => ids.has(b.chapterId));
  if (relevant.length === 0) return null;

  const epub = new EpubCFI();
  let picked: string | null = null;
  for (const b of relevant) {
    if (epub.compare(b.cfi, cfi) <= 0) picked = b.chapterId;
    else break;
  }
  return picked;
}
```

- [ ] **Step 4: 跑测试** — `pnpm test src/renderer/reader/chapter-id-at-cfi.test.ts` → PASS（含第一轮 href 级用例 + 新 anchor 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/chapter-id-at-cfi.ts src/renderer/reader/chapter-id-at-cfi.test.ts
git commit -m "feat(reader): add anchor-level subdivision to chapterIdAtCfi"
```

---

## Task 3: `epub-book.ts` 新增 `anchorCfi`（typecheck）

**Files:** Modify `src/renderer/reader/epub-book.ts`

- [ ] **Step 1: 接口 + 实现** — 在 `EpubBook` 接口加：

```ts
/** 确保 section 已渲染，为其中 anchorId 元素生成 point CFI；失败返回 null。 */
anchorCfi: (index: number, anchorId: string) => Promise<string | null>;
```

在 `createEpubBook` 返回对象里实现（放在 `cfiFromElement` 附近）：

```ts
    anchorCfi: async (index, anchorId) => {
      const s = sectionAt(index);
      if (!s) return null;
      try {
        // s.document 在 render 前为 undefined；未就绪先 render（与 loadSection 同路径）。
        if (!s.document) await (s.render(book.load.bind(book)) as unknown as Promise<string>);
        const el = s.document?.getElementById(anchorId) ?? null;
        if (!el) return null;
        return new EpubCFI(el, s.cfiBase, ANNO_IGNORE_CLASS).toString();
      } catch {
        return null;
      }
    },
```

- [ ] **Step 2: typecheck** — `pnpm typecheck` → PASS。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/reader/epub-book.ts
git commit -m "feat(reader): add EpubBook.anchorCfi to generate anchor boundary CFIs"
```

---

## Task 4: `epub-session.tsx` 预计算 `anchorBoundaries`（typecheck）

**Files:** Modify `src/renderer/reader/epub-session.tsx`

- [ ] **Step 1: 实现** — 改动如下：

import 增：

```ts
import { type AnchorBoundary } from "./chapter-id-at-cfi";
import { basename } from "./chapter-id-by-href";
import type { ChapterRefDto } from "@shared/library";
import { EpubCFI } from "epubjs";
```

`EpubSession` 接口加字段：

```ts
  anchorBoundaries: AnchorBoundary[];
```

Provider 内（`book`/`parseError` 声明附近）加 state + chapters query：

```ts
const [anchorBoundaries, setAnchorBoundaries] = useState<AnchorBoundary[]>([]);
const chapters = useQuery({
  queryKey: qk.chapters(bookId),
  queryFn: () => window.api.content.chapters({ bookId }),
  staleTime: Infinity,
  enabled,
});
```

加预计算 effect（放 createEpubBook effect 之后）：

```ts
// 共享 href（锚点切章）的章节需 anchor 级边界 CFI 才能归属标注。开书后异步预计算：
// 渲染相关 section、为每个锚点章生成起点 CFI，按 CFI 升序存。未就绪时侧栏退化 href 级。
useEffect(() => {
  if (!book || !chapters.data) {
    setAnchorBoundaries([]);
    return;
  }
  const chs = chapters.data;
  let alive = true;
  void (async () => {
    try {
      const byBase = new Map<string, ChapterRefDto[]>();
      for (const c of chs) {
        const base = basename(c.href);
        const list = byBase.get(base) ?? [];
        list.push(c);
        byBase.set(base, list);
      }
      const out: AnchorBoundary[] = [];
      for (const group of byBase.values()) {
        if (group.length <= 1) continue; // href 唯一，href 级已足够
        const withAnchor = group.filter((c) => c.anchor);
        if (withAnchor.length === 0) continue;
        const index = book.indexOfHref(group[0]!.href);
        if (index < 0) continue;
        for (const c of withAnchor) {
          const cfi = await book.anchorCfi(index, c.anchor!);
          if (cfi) out.push({ chapterId: c.id, cfi });
        }
      }
      const epub = new EpubCFI();
      out.sort((a, b) => epub.compare(a.cfi, b.cfi));
      if (alive) setAnchorBoundaries(out);
    } catch (err) {
      log.warn("anchor boundary precompute failed", err);
      if (alive) setAnchorBoundaries([]);
    }
  })();
  return () => {
    alive = false;
  };
}, [book, chapters.data]);
```

context value 加 `anchorBoundaries`：

```ts
      value={{ book, spineHrefs, anchorBoundaries, parseError, bytesError: bytes.isError }}
```

- [ ] **Step 2: typecheck** — `pnpm typecheck` → PASS。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/reader/epub-session.tsx
git commit -m "feat(reader): precompute anchor boundary CFIs in epub session"
```

---

## Task 5: `AnnotationsList.tsx` 接线（typecheck）

**Files:** Modify `src/renderer/reader/AnnotationsList.tsx`

- [ ] **Step 1: 实现** — 把 `const { spineHrefs } = useEpubSession();` 改为 `const { spineHrefs, anchorBoundaries } = useEpubSession();`；ePub 分支调用改为：

```ts
const chId = chapterIdAtCfi(chapters.data ?? [], spineHrefs, locator, anchorBoundaries);
return (chapters.data ?? []).find((c: ChapterRefDto) => c.id === chId)?.title ?? null;
```

- [ ] **Step 2: typecheck + test** — `pnpm typecheck` → PASS；`pnpm test src/renderer/reader/` → PASS。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/reader/AnnotationsList.tsx
git commit -m "feat(reader): feed anchor boundaries to annotation chapter lookup"
```

---

## Task 6: 全量验证 + 冒烟 + changeset

**Files:** Create changeset

- [ ] **Step 1: 全量** — `pnpm test src/renderer/reader/` + `pnpm typecheck` + `pnpm lint` 全 PASS。

- [ ] **Step 2: CDP 冒烟（人工）** — 启动：`pnpm build:packages && pnpm exec electron-forge start -- --remote-debugging-port=9222 --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding`（dev 默认 userData，勿传 --user-data-dir）。验证用一本「共享 href 锚点章 + 文件在库」的书（dev 库的「早起的奇迹」文件已丢失；若无合适书，临时导入一本单文件锚点章 epub 并标注）：
  1. 在不同锚点章各划词标注 → 侧栏标注章节显示**正确锚点章**（非空、非错章）。
  2. 多 spine 书（被讨厌的勇气）标注章节不回归。
  3. 进度恢复 / 跳章 / 选区 / TTS 不回归。

- [ ] **Step 3: changeset** — `pnpm changeset`（patch / fix）：

```
fix: epub highlights in single-file (anchor-split) books now show the correct chapter

Books where every chapter shares one spine file (TOC split by anchors) previously
showed no chapter for highlights. Annotation chapter lookup now subdivides a shared
href to the right anchor chapter using precomputed boundary CFIs.
```

- [ ] **Step 4: 提交** — `git add .changeset && git commit -m "chore: add changeset for anchor-level chapter attribution"`

---

## 完成后

- 整个 feature（href 级 + anchor 级）在 `fix/epub-annotation-chapter-attribution` 分支；用 `superpowers:finishing-a-development-branch` 决定合并。
- 用 `kanban` skill 补建并关联 issue。
