# ePub 标注章节归属修复 + book 实例提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 ePub 标注侧栏「所属章节」与选段实际章节不一致的 bug，并把 epubjs `book` 实例从 `EpubReader` 局部状态提升为 ReaderView 级 epub-session context。

**Architecture:** 新增唯一的章节计算纯函数 `chapterIdAtCfi`（与 PDF `chapterIdAtPage` 对称，内部用 `EpubCFI` 解析 `spinePos` → `spineHrefs[pos]` → 复用 `chapterIdByHref`）。把 `book` 的创建/持有从 `EpubReader` 搬进 `EpubSessionProvider`，`EpubReader` 与 `AnnotationsList` 都从 `useEpubSession()` 消费；context 派生暴露 `spineHrefs` 供侧栏喂纯函数。

**Tech Stack:** React 19 (+ React Compiler)、@tanstack/react-query、epubjs（`EpubCFI`）、vitest（Electron-as-node 运行时）、TypeScript strict。

**前置事实（已实测，勿重复探测）：**

- `epubjs` 可在 vitest 运行时 import；`new EpubCFI(cfi).spinePos` 对 `/6/N` 返回 `N/2 - 1`（`/6/2`→0、`/6/6`→2、`/6/8`→3、`/6/14`→6）。
- `new EpubCFI("not-a-cfi")` **构造时即抛** `TypeError` → 解析必须 `try/catch`。
- `ChapterRefDto` 字段：`{ id, title: string|null, href, anchor: string|null, orderIndex, level, startPage: number|null, endPage: number|null }`（`src/shared/library.ts:83-92`）。
- 单测以「先 assert 错误根因场景」为主：spine 前有封面/版权页 → `spinePos` 偏移，旧 `spinePos===orderIndex` 逻辑必错。

---

## Task 1: 纯函数 `chapterIdAtCfi`（TDD）

**Files:**

- Create: `src/renderer/reader/chapter-id-at-cfi.ts`
- Test: `src/renderer/reader/chapter-id-at-cfi.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/reader/chapter-id-at-cfi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtCfi } from "./chapter-id-at-cfi";

const ch = (id: string, href: string, orderIndex: number): ChapterRefDto => ({
  id,
  title: id,
  href,
  anchor: null,
  orderIndex,
  level: 0,
  startPage: null,
  endPage: null,
});

// spine 物理顺序：cover(0), copyright(1), chap1(2), chap2(3)
const spineHrefs = ["cover.xhtml", "copyright.xhtml", "text/chap1.xhtml", "text/chap2.xhtml"];
// 章节是 TOC 子集（封面/版权不在），orderIndex 跟 TOC 走、与 spinePos 基准不同
const chapters = [ch("id-c1", "text/chap1.xhtml", 0), ch("id-c2", "text/chap2.xhtml", 1)];

describe("chapterIdAtCfi", () => {
  it("maps spinePos to the right chapter despite cover/copyright offset (the bug)", () => {
    // /6/6 → spinePos 2 → spineHrefs[2] = text/chap1.xhtml → id-c1
    // 旧逻辑会拿 spinePos 2 撞 orderIndex 2（不存在）→ 错章/空
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/6!/4/2/1:0)")).toBe("id-c1");
    // /6/8 → spinePos 3 → text/chap2.xhtml → id-c2
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/8!/4/2/1:0)")).toBe("id-c2");
  });

  it("returns null for a non-chapter spine item (cover)", () => {
    // /6/2 → spinePos 0 → cover.xhtml（不在 chapters）→ null
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/2!/4/2/1:0)")).toBeNull();
  });

  it("returns null when spinePos is out of range", () => {
    // /6/20 → spinePos 9 → spineHrefs[9] = undefined → null
    expect(chapterIdAtCfi(chapters, spineHrefs, "epubcfi(/6/20!/4/2/1:0)")).toBeNull();
  });

  it("returns null for an invalid CFI (EpubCFI throws)", () => {
    expect(chapterIdAtCfi(chapters, spineHrefs, "not-a-cfi")).toBeNull();
  });

  it("returns null when spineHrefs is empty (book not ready)", () => {
    expect(chapterIdAtCfi(chapters, [], "epubcfi(/6/6!/4/2/1:0)")).toBeNull();
  });

  it("falls back to basename when spine href prefix differs from chapter href", () => {
    // spineHrefs 是 epubjs 裸 href；chapters 带 OEBPS 前缀 → exact 不中、basename 命中
    const prefixed = [ch("id-c1", "OEBPS/text/chap1.xhtml", 0)];
    expect(chapterIdAtCfi(prefixed, spineHrefs, "epubcfi(/6/6!/4/2/1:0)")).toBe("id-c1");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test src/renderer/reader/chapter-id-at-cfi.test.ts`
Expected: FAIL —— `chapterIdAtCfi` 未定义 / 模块不存在。

- [ ] **Step 3: 写实现**

Create `src/renderer/reader/chapter-id-at-cfi.ts`:

```ts
import { EpubCFI } from "epubjs";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref } from "./chapter-id-by-href";

/**
 * ePub 标注/位置 CFI → 章节 id（与 PDF 的 chapterIdAtPage 对称）。
 * CFI 的 spinePos（epubjs spine 物理位置）→ spineHrefs[pos]（spine 顺序的 href）→ chapterIdByHref。
 * 切勿用 CFI.spinePos 去撞 chapter.orderIndex：orderIndex 是 TOC 扁平下标，与 spinePos 基准不同。
 */
export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
): string | null {
  let pos: number;
  try {
    pos = new EpubCFI(cfi).spinePos ?? -1; // 无效 CFI：构造即抛 → catch
  } catch {
    return null;
  }
  const href = pos >= 0 ? spineHrefs[pos] : undefined; // 越界/负 → undefined
  return href ? chapterIdByHref(chapters, href) : null;
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm test src/renderer/reader/chapter-id-at-cfi.test.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/chapter-id-at-cfi.ts src/renderer/reader/chapter-id-at-cfi.test.ts
git commit -m "feat(reader): add chapterIdAtCfi for epub annotation chapter lookup"
```

（pre-commit 钩子会跑 lint:fix + format；若因「files were modified by this hook」中止，重新 `git add` 被改文件再执行同一 commit。）

---

## Task 2: 把 book 提升为 ReaderView 级 epub-session context

无单测（涉及 epubjs/iframe，无头不可测）；以 `pnpm typecheck` 为关卡。原子重构：创建 context + ReaderView 包裹 + EpubReader 改读 context，必须一起完成才能编译与运行正确。

**Files:**

- Create: `src/renderer/reader/epub-session.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx`
- Modify: `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: 创建 `epub-session.tsx`**

Create `src/renderer/reader/epub-session.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createLogger } from "@renderer/logger";
import { qk } from "@renderer/query/keys";
import { createEpubBook, type EpubBook } from "./epub-book";

const log = createLogger("epub");

export interface EpubSession {
  book: EpubBook | null;
  /** spine 物理顺序的 href（book 就绪后派生）；book 未就绪 / 非 epub 时为空数组。 */
  spineHrefs: string[];
  parseError: string | null;
  bytesError: boolean;
}

const EpubSessionContext = createContext<EpubSession | null>(null);

export function useEpubSession(): EpubSession {
  const ctx = useContext(EpubSessionContext);
  if (!ctx) throw new Error("useEpubSession must be used within EpubSessionProvider");
  return ctx;
}

/**
 * book 实例归 ReaderView 范围状态：EpubReader 与 AnnotationsList 都从这里消费。
 * 仅 ePub 书创建 book（enabled=false 时 PDF：book=null、spineHrefs=[]，PdfReader 不消费本 context）。
 */
export function EpubSessionProvider({
  bookId,
  enabled,
  children,
}: {
  bookId: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
    enabled,
  });

  useEffect(() => {
    if (!bytes.data) return;
    let alive = true;
    let created: EpubBook | null = null;
    setParseError(null);
    createEpubBook(bytes.data)
      .then((b) => {
        if (!alive) {
          b.destroy();
          return;
        }
        created = b;
        setBook(b);
      })
      .catch((err: unknown) => {
        if (alive) {
          log.error("epub parse failed", err);
          setParseError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
    };
  }, [bytes.data]);

  const spineHrefs = book
    ? Array.from({ length: book.count }, (_, i) => book.hrefAtIndex(i) ?? "")
    : [];

  return (
    <EpubSessionContext.Provider
      value={{ book, spineHrefs, parseError, bytesError: bytes.isError }}
    >
      {children}
    </EpubSessionContext.Provider>
  );
}
```

- [ ] **Step 2: ReaderView 包裹 Provider**

Modify `src/renderer/reader/ReaderView.tsx`:

加 import（与现有 reader import 同段）：

```tsx
import { EpubSessionProvider } from "@renderer/reader/epub-session";
```

把当前包含 Sidebar / main / AIPanel 的容器（`ReaderView.tsx:253` 的 `<div className="relative flex min-h-0 flex-1 overflow-hidden">…</div>`）用 `EpubSessionProvider` 包起来。即：

```tsx
<EpubSessionProvider bookId={bookId} enabled={book.data?.format === "epub"}>
  <div className="relative flex min-h-0 flex-1 overflow-hidden">
    {/* …原 Sidebar / main / AIPanel 内容原样保留… */}
  </div>
</EpubSessionProvider>
```

注意：`bookId` 在此处已非空（`ReaderView.tsx:93` 的 `if (!bookId) return null` 守卫）。`book` 是 `library.get` 的 DTO（`ReaderView.tsx:71`），`book.data?.format === "epub"` 即 ePub 书。`SelectionToolbar` 等浮层（`ReaderView.tsx:283-286`）在该容器之外、不消费 context，无需包入。

- [ ] **Step 3: EpubReader 改读 context + 接管 reader ref 切书重置**

Modify `src/renderer/reader/EpubReader.tsx`:

**(a) 改 import：**

- `import { useEffect, useRef, useState } from "react";` → `import { useEffect, useRef } from "react";`（book/parseError 两个 useState 移走后 EpubReader 不再用 useState）
- 删除 `import { createEpubBook, type EpubBook } from "./epub-book";`
- 新增 `import { useEpubSession } from "./epub-session";`

**(b) 删除以下本地状态与 effect：**

- `const [book, setBook] = useState<EpubBook | null>(null);`（`EpubReader.tsx:55`）
- `const [parseError, setParseError] = useState<string | null>(null);`（`EpubReader.tsx:56`）
- `bytes` query 整块（`EpubReader.tsx:81-85`）
- `createEpubBook` 的整个 `useEffect`（`EpubReader.tsx:100-129`）

**(c) 在原 `book`/`parseError` 声明处改为从 context 读：**

```tsx
const { book, parseError, bytesError } = useEpubSession();
```

**(d) 新增「换书重置 reader 自有状态」effect**（原本随 book 创建 effect 的 cleanup 做，现 book 已提升，须由 EpubReader 接管，否则换书会把上一本的进度恢复/待写进度/顶部章快照串到下一本）。放在其它 effect 附近：

```tsx
// book 生命周期已提升到 EpubSessionProvider；reader 自有状态的「切书重置」改由此处接管。
useEffect(() => {
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = null;
  topChapterIdRef.current = null;
  topSectionIndexRef.current = 0;
  restoredRef.current = false;
}, [bookId]);
```

**(e) 错误态判断改用 `bytesError`：**

- `if (bytes.isError)`（`EpubReader.tsx:395`）→ `if (bytesError)`

其余所有 `book.*` 消费点、`progress`/`annotations` query、refs、渲染逻辑**原样不动**。

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: PASS（无 `bytes` 未定义、无 `useState` unused、无 `EpubBook` unused import 等报错）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reader/epub-session.tsx src/renderer/reader/ReaderView.tsx src/renderer/reader/EpubReader.tsx
git commit -m "refactor(reader): lift epub book instance into ReaderView-scoped session context"
```

---

## Task 3: AnnotationsList 改走 `chapterIdAtCfi`（修 bug）

**Files:**

- Modify: `src/renderer/reader/AnnotationsList.tsx`

- [ ] **Step 1: 改造组件**

Modify `src/renderer/reader/AnnotationsList.tsx`:

**(a) 删除 `spineOf` 函数（`AnnotationsList.tsx:16-22`）和 `import { EpubCFI } from "epubjs";`（`AnnotationsList.tsx:3`，仅 `spineOf` 用它）。**

**(b) 新增 import：**

```tsx
import { chapterIdAtCfi } from "./chapter-id-at-cfi";
import { useEpubSession } from "./epub-session";
```

**(c) 在组件内取 `spineHrefs`（与其它 hook 调用同段，如 `requestScroll` 附近）：**

```tsx
const { spineHrefs } = useEpubSession();
```

**(d) 把 `chapterTitle` 里的 ePub 分支（`AnnotationsList.tsx:70-72`）：**

```tsx
const sp = spineOf(locator);
const ch = (chapters.data ?? []).find((c: ChapterRefDto) => c.orderIndex === sp);
return ch?.title ?? null;
```

**改为：**

```tsx
const chId = chapterIdAtCfi(chapters.data ?? [], spineHrefs, locator);
return (chapters.data ?? []).find((c: ChapterRefDto) => c.id === chId)?.title ?? null;
```

PDF 分支（`parsePdfLocatorRange` + `chapterIdAtPage`，`AnnotationsList.tsx:63-69`）原样不动。book 未就绪 / PDF 书时 `spineHrefs=[]` → `chapterIdAtCfi` 返回 null → 章节显示为空（与现状一致，不显示错章）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS（`spineOf` 已删无残留引用；`ChapterRefDto` 类型仍在用）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/reader/AnnotationsList.tsx
git commit -m "fix(reader): attribute epub annotations to their actual chapter via chapterIdAtCfi"
```

---

## Task 4: 全量验证 + 冒烟 + changeset

**Files:**

- Create: changeset 条目（`pnpm changeset`）

- [ ] **Step 1: 全量测试 + 类型 + lint**

Run:

```bash
pnpm test src/renderer/reader/
pnpm typecheck
pnpm lint
```

Expected: 全 PASS。

- [ ] **Step 2: CDP 冒烟（人工/交互，带封面页 ePub）**

启动 dev（隔离 userData 见记忆 `dev-cdp-smoke-args-gotcha`），逐项目视断言：

1. 开一本**带封面页**的 ePub，在第 2、3 章各划词标注 → 切到侧栏「标注」tab，每条标注下方章节标题**与选段实际所在章节一致**（核心验收；修复前会错章或空）。
2. 进度恢复（关书重开回到原位）、ChapterList 跳章、选区高亮渲染、TTS 朗读起读 **均无回归**（验证 Task 2 拆分未破坏 book 生命周期/时序）。
3. 切到另一本书再切回原书，标注章节仍正确、进度不串书（验证 Task 2 Step 3(d) 的 ref 重置接管生效）。

- [ ] **Step 3: changeset（用户向英文 changelog）**

Run: `pnpm changeset`
内容（patch / fix）示例：

```
fix: epub annotations now show the chapter the highlight actually belongs to

Highlights in the sidebar were attributed to the wrong chapter (or none) because
chapter lookup matched a CFI's spine position against the TOC-based order index.
Annotations now resolve their chapter from the spine href, matching how current-chapter
tracking already works.
```

- [ ] **Step 4: 提交 changeset**

```bash
git add .changeset
git commit -m "chore: add changeset for epub annotation chapter fix"
```

---

## 完成后

- 用 `superpowers:finishing-a-development-branch` 决定合并方式（本地 main rebase 线性工作流，见记忆 `local-main-rebase-linear-workflow`）。
- 用 `kanban` skill 补建并关联本 bug 的 GitHub issue（spec 里 Issue 字段标的「待建」）。
