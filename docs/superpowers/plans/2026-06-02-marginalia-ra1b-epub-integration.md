# RA1-full · Plan B：app ePub 集成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把渲染层从 RA1-min 的「静态纯文本」升级为**全书连续滚动**的真实 ePub 渲染（HTML/CSS/图片，内存有界）+ **CFI 锚定**（进度存取、跳章、当前章），并把 RA2 选区从「字符偏移」迁到「虚拟化 iframe + CFI」——**AI 契约零改动**。

**Architecture:** 主进程新增 `readEpubBytes` IPC 把 ePub 字节送渲染层；渲染层用 **epubjs**（解析/资源/CFI 库，不用其 Rendition/manager）把每个 spine 项 `render` 成资源已解析的 HTML，喂给已验证的 **`@marginalia/virtual-docs`** 包（react-virtuoso 虚拟化 iframe 列表）。`EpubReader` 替换 `ReaderPane`，接 CFI 进度/跳章/当前章/偏好注入/选区桥。epub.js↔包 的胶水（`epub-book.ts`/`epub-selection.ts`）+ 纯映射（`chapter-id-by-href.ts`/`prefs-to-css.ts`）留 app 侧。

**Tech Stack:** Electron 41 + React 19 + `@marginalia/virtual-docs`（workspace 源码包）+ **epubjs 0.3.93**（自带 `types/index.d.ts`）+ TanStack Query + zustand + vitest（headless 纯逻辑）。

**ABI 提示（执行者必读）：** Task 2 装 `epubjs` 会让 `pnpm install` 把 better-sqlite3 重编为 Node ABI（137）→ 装完**必须** `pnpm db:rebuild:electron` 翻回 Electron ABI（145），否则 `pnpm test` 加载 better-sqlite3 失败。

**前置（已完成）：** Plan A 的 `@marginalia/virtual-docs` 已合并 main，公开 API：

```ts
VirtualDocs                              // forwardRef 组件
VirtualDocsHandle  = { scrollToIndex(index: number): void }
VirtualDocsProps   = { count; loadSection(i)=>Promise<string>; styleCss?; initialIndex?;
                       onTopIndexChange?(i); onSelect?(e: SectionSelectEvent); onSelectionCleared?() }
SectionSelectEvent = { index: number; range: Range; doc: Document; rect: ViewportRect; text: string }
ViewportRect       = { x: number; y: number; width: number; height: number }
```

主应用尚未把 `@marginalia/virtual-docs` 列为依赖——Task 4 接入时加 `"@marginalia/virtual-docs": "workspace:*"`。

---

## 文件结构

| 文件                                             | 责任                                                     | 改动   |
| ------------------------------------------------ | -------------------------------------------------------- | ------ |
| `src/shared/ipc.ts`                              | 加 `libraryReadEpubBytes` 通道常量                       | Modify |
| `src/main/library/book-bytes.ts`                 | 纯函数 `readBookBytes(db,bookId)→Uint8Array`             | Create |
| `src/main/library/book-bytes.test.ts`            | headless 测（返字节 / 缺书抛错）                         | Create |
| `src/main/ipc/library-handlers.ts`               | 注册 `library:read-epub-bytes` handler                   | Modify |
| `src/preload.ts`                                 | 暴露 `library.readEpubBytes` + `progress.get/save`       | Modify |
| `src/renderer/reader/chapter-id-by-href.ts`      | 纯函数 `(chapters,href)→id\|null`                        | Create |
| `src/renderer/reader/chapter-id-by-href.test.ts` | headless 测                                              | Create |
| `src/renderer/reader/prefs-to-css.ts`            | 纯函数 `(prefs)→cssString`                               | Create |
| `src/renderer/reader/prefs-to-css.test.ts`       | headless 测                                              | Create |
| `src/renderer/reader/epub-book.ts`               | epubjs 胶水：解析 + `loadSection`/spine 映射/CFI 辅助    | Create |
| `src/renderer/reader/epub-selection.ts`          | `SectionSelectEvent`→块级取段+CFI→`SelectionInfo`        | Create |
| `src/renderer/reader/EpubReader.tsx`             | 取字节→解析→`VirtualDocs`→CFI/进度/跳章/当前章/偏好/选区 | Create |
| `src/renderer/reader/ReaderView.tsx`             | `ReaderPane`→`EpubReader`                                | Modify |
| `src/renderer/types.ts`                          | `SelectionInfo` 加 `cfiRange`                            | Modify |
| `src/renderer/query/keys.ts`                     | 加 `qk.epubBytes`/`qk.progress`；删 `qk.chapter`         | Modify |
| `src/renderer/reader/ReaderPane.tsx`             | 删                                                       | Delete |
| `src/renderer/reader/useSelection.ts`            | 删                                                       | Delete |
| 根 `package.json`                                | 加 `epubjs` + `@marginalia/virtual-docs` 依赖            | Modify |

> 主进程 `content.chapterText`/`readChapterText` 工具/章节摘要**不动**——仍从字节抽纯文本喂 AI；渲染层只负责显示（spec §2 决策 5）。

---

## Task 1: `readEpubBytes` IPC + preload（含 progress 暴露）

**Files:**

- Modify: `src/shared/ipc.ts`
- Create: `src/main/library/book-bytes.ts`
- Test: `src/main/library/book-bytes.test.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/preload.ts`

> 渲染层 epubjs 需要 ePub 原始字节。新增 `library:read-epub-bytes`（镜像 `send-deps.ts` 的 `createLoadBytes`：`getBook→readFile(book.path)→Uint8Array`）。把取字节逻辑抽成纯函数 `readBookBytes(db,bookId)` 便于 headless 测。顺带补 `progress.get/save` 到 preload（主端 handler/通道/Zod/`progress.cfi` 列都已存在，仅 preload 未暴露）。

- [ ] **Step 1: 加通道常量** — `src/shared/ipc.ts` 的 `IPC` 对象里，在 `libraryPickEpub` 行后加：

```ts
  libraryReadEpubBytes: "library:read-epub-bytes",
```

- [ ] **Step 2: 写失败测试** — `src/main/library/book-bytes.test.ts`：

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@main/db/client";
import type { DB } from "@main/db/client";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { importBook } from "@main/library/import";
import { readBookBytes } from "./book-bytes";

describe("readBookBytes", () => {
  let db: DB;
  let dir: string;
  let bookId: string;
  let bytes: Uint8Array;

  beforeAll(async () => {
    db = createDb(":memory:");
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-bb-"));
    bytes = makeFixtureEpub();
    const filePath = path.join(dir, "fixture.epub");
    await writeFile(filePath, bytes);
    const dto = importBook(db, { bytes, filePath });
    bookId = dto.id;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the on-disk ePub bytes for a known book", async () => {
    const out = await readBookBytes(db, bookId);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(bytes.byteLength);
  });

  it("throws a readable error for an unknown book", async () => {
    await expect(readBookBytes(db, "no-such-book")).rejects.toThrow(/book .* not found/);
  });
});
```

> 注意：`makeFixtureEpub` / `importBook` 的确切导出名/签名以仓库现状为准——`makeFixtureEpub` 由 `@marginalia/epub-parser` 导出（recon 已确认）；`importBook(db, { bytes, filePath })` 返回 `BookSummaryDto`（含 `id`）。实现前若签名不符，按真实签名微调测试的 import/调用，不要改变测试意图（返字节 / 缺书抛错）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/library/book-bytes.test.ts`
Expected: FAIL（`./book-bytes` 模块/`readBookBytes` 不存在）。

- [ ] **Step 4: 实现 `book-bytes.ts`** — `src/main/library/book-bytes.ts`：

```ts
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";

/**
 * 读取某书的原始 ePub 字节（渲染层 epubjs 解析用）。
 * 纯函数（注入 DB），镜像 send-deps.ts 的 createLoadBytes 取字节模式。
 */
export async function readBookBytes(db: DB, bookId: string): Promise<Uint8Array> {
  const book = db.select({ path: books.path }).from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error(`readBookBytes: book ${bookId} not found`);
  const buf = await readFile(book.path);
  return new Uint8Array(buf);
}
```

> `getBook` 若已存在（recon 见 `library-handlers`/`send-deps` 用 `getBook(db,id)`），可改为 `const book = getBook(db, bookId)` 并 `if (!book) throw ...; const buf = await readFile(book.path);`——二选一，保持「缺书抛可读错误」语义即可。上面用直接 `select` 避免耦合，二者均可。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/library/book-bytes.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 6: 注册 handler** — `src/main/ipc/library-handlers.ts`：在文件顶部 import 区加 `import { readBookBytes } from "@main/library/book-bytes";`，并在 `registerLibraryHandlers()` 内（与其它 `library:*` handler 并列）加：

```ts
handle(IPC.libraryReadEpubBytes, bookIdInput, (input) => readBookBytes(getDb(), input.bookId));
```

> `handle`/`bookIdInput`/`getDb`/`IPC` 应已在该文件 import（与现有 `libraryGet` 等同款）。若 `bookIdInput` 未 import，从 `@shared/library` 补；`IPC` 从 `@shared/ipc`。

- [ ] **Step 7: 暴露 preload** — `src/preload.ts`：在 `library` 命名空间对象里加 `readEpubBytes`，并在 `api` 顶层加 `progress` 命名空间。`library` 加：

```ts
    readEpubBytes: (input: BookIdInput): Promise<Uint8Array> =>
      ipcRenderer.invoke(IPC.libraryReadEpubBytes, input),
```

在 `api` 对象里（与 `library`/`content` 并列）加：

```ts
  progress: {
    get: (input: BookIdInput): Promise<{ cfi: string } | null> =>
      ipcRenderer.invoke(IPC.progressGet, input),
    save: (input: SaveProgressInput): Promise<void> =>
      ipcRenderer.invoke(IPC.progressSave, input),
  },
```

> `BookIdInput`/`SaveProgressInput` 从 `@shared/library` import（`SaveProgressInput = { bookId, cfi }`，recon 确认）。`IPC.progressGet`/`IPC.progressSave` 常量已存在。`progress.get` 的返回形状以主端 `getProgress` 实际返回为准（recon：`{ cfi } | null`）。

- [ ] **Step 8: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/main/library/book-bytes.ts src/main/library/book-bytes.test.ts src/main/ipc/library-handlers.ts src/preload.ts
git commit -m "feat(reader): add readEpubBytes IPC and expose progress on preload"
```

---

## Task 2: 装 epubjs + 纯映射函数（`chapterIdByHref` / `prefsToCss`，headless 测）

**Files:**

- Modify: 根 `package.json`（经 `pnpm add`）
- Create: `src/renderer/reader/chapter-id-by-href.ts` + `.test.ts`
- Create: `src/renderer/reader/prefs-to-css.ts` + `.test.ts`

> 两个纯映射：`chapterIdByHref` 把 epubjs spine 项 href 映射到 `ChapterRefDto.id`（当前章高亮/进度用；去 `#fragment` + 末段路径兜底，因 TOC href 可能带锚点）；`prefsToCss` 把 `ReaderPrefs` 转成注入 iframe 的 CSS 串。先装 epubjs（Task 3+ 用），翻 ABI。

- [ ] **Step 1: 装 epubjs + 翻 ABI**

```bash
pnpm add epubjs
pnpm db:rebuild:electron
```

Expected: `epubjs`（^0.3.93）写进根 `package.json` `dependencies`；`db:rebuild:electron` 完成（`✔ Rebuild Complete`）。epubjs 自带 `types/index.d.ts`，无需 `@types/epubjs`。

- [ ] **Step 2: 验证 ABI 已翻回**

Run: `pnpm test 2>&1 | tail -3`
Expected: 全量测试通过（证明 better-sqlite3 ABI 回 145）。

- [ ] **Step 3: 写 `chapter-id-by-href` 失败测试** — `src/renderer/reader/chapter-id-by-href.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref } from "./chapter-id-by-href";

const chapters: ChapterRefDto[] = [
  { id: "id-cover", title: "Cover", href: "cover.xhtml", orderIndex: 0, level: 0 },
  { id: "id-c1", title: "Chapter 1", href: "text/chap1.xhtml", orderIndex: 1, level: 0 },
  { id: "id-c2", title: "Chapter 2", href: "text/chap2.xhtml", orderIndex: 2, level: 0 },
];

describe("chapterIdByHref", () => {
  it("matches an exact href", () => {
    expect(chapterIdByHref(chapters, "text/chap1.xhtml")).toBe("id-c1");
  });

  it("ignores a #fragment on the lookup href", () => {
    expect(chapterIdByHref(chapters, "text/chap2.xhtml#sec3")).toBe("id-c2");
  });

  it("falls back to basename when path prefixes differ", () => {
    expect(chapterIdByHref(chapters, "OEBPS/text/chap1.xhtml")).toBe("id-c1");
  });

  it("returns null when nothing matches", () => {
    expect(chapterIdByHref(chapters, "missing.xhtml")).toBeNull();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/chapter-id-by-href.test.ts`
Expected: FAIL（模块/导出不存在）。

- [ ] **Step 5: 实现 `chapter-id-by-href.ts`**：

```ts
import type { ChapterRefDto } from "@shared/library";

/** 去掉 #fragment 与查询串，得到纯路径。 */
function stripFragment(href: string): string {
  return href.split("#")[0]!.split("?")[0]!;
}

/** 取末段文件名（用于路径前缀不一致时的兜底匹配）。 */
function basename(href: string): string {
  const p = stripFragment(href);
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * 把 spine 项 href 映射到章节 id（当前章高亮/进度用）。
 * 先精确匹配（去 fragment），再退到 basename 匹配（epubjs 与 epub-parser 的 href
 * 路径前缀可能不同）。都不中返回 null（当前章不高亮，可接受边界）。
 */
export function chapterIdByHref(chapters: ChapterRefDto[], href: string): string | null {
  const target = stripFragment(href);
  const exact = chapters.find((c) => stripFragment(c.href) === target);
  if (exact) return exact.id;
  const base = basename(href);
  const byBase = chapters.find((c) => basename(c.href) === base);
  return byBase ? byBase.id : null;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/chapter-id-by-href.test.ts`
Expected: PASS（4 用例）。

- [ ] **Step 7: 写 `prefs-to-css` 失败测试** — `src/renderer/reader/prefs-to-css.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { prefsToCss } from "./prefs-to-css";

describe("prefsToCss", () => {
  it("maps prefs to a body CSS rule", () => {
    const css = prefsToCss({ fontScale: 1, lineHeight: 1.9, maxWidth: 640 });
    expect(css).toContain("font-size: 100%");
    expect(css).toContain("line-height: 1.9");
    expect(css).toContain("max-width: 640px");
    expect(css).toContain("margin: 0 auto");
  });

  it("scales font-size by fontScale", () => {
    const css = prefsToCss({ fontScale: 1.25, lineHeight: 1.6, maxWidth: 720 });
    expect(css).toContain("font-size: 125%");
    expect(css).toContain("max-width: 720px");
  });
});
```

- [ ] **Step 8: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/prefs-to-css.test.ts`
Expected: FAIL（模块/导出不存在）。

- [ ] **Step 9: 实现 `prefs-to-css.ts`**：

```ts
import type { ReaderPrefs } from "../types";

/**
 * 把阅读偏好转成注入每个 section iframe 的 CSS 串（承载字号/行距/正文宽度）。
 * font-size 用百分比（相对 ePub 自身字号），正文居中限宽。
 */
export function prefsToCss(prefs: ReaderPrefs): string {
  const fontPct = Math.round(prefs.fontScale * 100);
  return [
    `html { font-size: ${fontPct}%; }`,
    `body {`,
    `  line-height: ${prefs.lineHeight};`,
    `  max-width: ${prefs.maxWidth}px;`,
    `  margin: 0 auto;`,
    `  padding: 1rem;`,
    `}`,
    `img { max-width: 100%; height: auto; }`,
  ].join("\n");
}
```

> `ReaderPrefs` 在 `src/renderer/types.ts`（`{ fontScale; lineHeight; maxWidth }`，recon 确认）。

- [ ] **Step 10: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/prefs-to-css.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml src/renderer/reader/chapter-id-by-href.ts src/renderer/reader/chapter-id-by-href.test.ts src/renderer/reader/prefs-to-css.ts src/renderer/reader/prefs-to-css.test.ts
git commit -m "feat(reader): add epubjs dep and chapterIdByHref/prefsToCss pure helpers"
```

---

## Task 3: `epub-book.ts` —— epubjs 胶水（解析 + loadSection + spine 映射 + CFI）

**Files:**

- Create: `src/renderer/reader/epub-book.ts`

> 封装 epubjs：`ePub(bytes)`→`book.ready`→暴露 `count`/`loadSection(i)`（`section.render` 得资源已解析 HTML 串喂包）/`hrefAtIndex`/`indexOfHref`/`cfiAtIndex`（进度，section 起点 CFI）/`indexOfCfi`（恢复，`EpubCFI.spinePos`）/`cfiFromRange`（选区落点）。**无 headless 测**（epubjs 需浏览器 DOM；vitest 跑在无 DOM 的 electron-as-node）——靠 Task 4+ 手测。**关键**：包 `onSelect` 给的 `range` 在 iframe(srcdoc) 内，但其 DOM 树 == `section.render` 输出的 HTML 树，故 `section.cfiFromRange(iframeRange)` 路径一致、CFI 有效。

- [ ] **Step 1: 核对 epubjs 自带类型签名**

Run: `sed -n '1,80p' node_modules/epubjs/types/index.d.ts` 并查看 `node_modules/epubjs/types/section.d.ts`、`epubcfi.d.ts`、`spine.d.ts`、`book.d.ts`。
确认下列用到的 API 的确切签名（不同 patch 可能微调），实现时以真实 `.d.ts` 为准：

- `ePub(input: ArrayBuffer | string, options?): Book`、`book.ready: Promise<...>`
- `book.spine`：`spine.get(target: string | number): Section`、`spine.length`/`spine.items`、`section.index`/`section.href`
- `Section`：`render(request?): Promise<string>`、`cfiFromElement(el: Element): string`、`cfiFromRange(range: Range): string`、`unload()`、`document: Document`
- `EpubCFI`：`new EpubCFI(cfi: string)`、`.spinePos: number`（0-based spine 序）

记录任何与下方实现不符之处，并据真实签名微调（保持职责不变）。

- [ ] **Step 2: 写 `epub-book.ts`**：

```ts
import ePub, { EpubCFI, type Book, type Section } from "epubjs";

export interface EpubBook {
  /** spine 项数（= VirtualDocs 的 count）。 */
  count: number;
  /** 渲染第 index 个 spine 项为资源已解析的 HTML 串（喂 VirtualDocs.loadSection）。 */
  loadSection: (index: number) => Promise<string>;
  /** spine 项的 href（→ chapterIdByHref → 当前章/进度）。 */
  hrefAtIndex: (index: number) => string | null;
  /** href → spine index（跳章）；找不到返回 -1。 */
  indexOfHref: (href: string) => number;
  /** 顶部 section 起点 CFI（进度存储）；section 未就绪返回 null。 */
  cfiAtIndex: (index: number) => string | null;
  /** CFI → spine index（恢复）；非法/越界返回 -1。 */
  indexOfCfi: (cfi: string) => number;
  /** iframe range → CFI（选区落点）；失败返回 null。 */
  cfiFromRange: (index: number, range: Range) => string | null;
  /** 释放 epubjs 资源（卸载书、blob URL）。 */
  destroy: () => void;
}

/** 取 section 文档里第一个块级元素（section 起点 CFI 的锚）。 */
function firstBlock(doc: Document): Element {
  return doc.body?.firstElementChild ?? doc.documentElement;
}

/**
 * 用 epubjs 解析 ePub 字节，暴露虚拟化渲染 + CFI 所需的最小接口。
 * 不使用 epubjs 的 Rendition/manager（spec §2 决策 3）；仅作解析/资源/CFI 库。
 */
export async function createEpubBook(bytes: Uint8Array): Promise<EpubBook> {
  // epubjs 接受 ArrayBuffer；Uint8Array 取其底层 buffer。
  const book: Book = ePub(bytes.buffer as ArrayBuffer);
  await book.ready;

  const spine = book.spine;
  // spine 项数：epubjs 的 spine.length（或 spine.items.length）——以 Step 1 核对为准。
  const count: number = (spine as unknown as { length: number }).length;

  const sectionAt = (index: number): Section | null => {
    try {
      return spine.get(index) ?? null;
    } catch {
      return null;
    }
  };

  return {
    count,

    loadSection: async (index) => {
      const s = sectionAt(index);
      if (!s) return "<p>（本节不存在）</p>";
      // render 产出资源已解析的 HTML 串；request = book.load.bind(book)（spec §3.1）。
      // 渲染后 s.document 保留，供 cfiAtIndex/cfiFromRange（不 unload）。
      const html = await s.render(book.load.bind(book));
      return html;
    },

    hrefAtIndex: (index) => sectionAt(index)?.href ?? null,

    indexOfHref: (href) => {
      const bare = href.split("#")[0];
      const s = (() => {
        try {
          return spine.get(bare) ?? spine.get(href) ?? null;
        } catch {
          return null;
        }
      })();
      return s ? s.index : -1;
    },

    cfiAtIndex: (index) => {
      const s = sectionAt(index);
      if (!s || !s.document) return null;
      try {
        return s.cfiFromElement(firstBlock(s.document));
      } catch {
        return null;
      }
    },

    indexOfCfi: (cfi) => {
      try {
        const parsed = new EpubCFI(cfi);
        const pos = parsed.spinePos;
        return typeof pos === "number" && pos >= 0 ? pos : -1;
      } catch {
        return -1;
      }
    },

    cfiFromRange: (index, range) => {
      const s = sectionAt(index);
      if (!s) return null;
      try {
        return s.cfiFromRange(range);
      } catch {
        return null;
      }
    },

    destroy: () => {
      try {
        book.destroy();
      } catch {
        /* best-effort 释放 */
      }
    },
  };
}
```

> 上面对 epubjs 的少量 `as`/可选链是为吸收其 `.d.ts` 的宽松类型（`spine.length`、`section.document` 等）；Step 1 核对后若真实类型已精确，去掉多余断言。`cfiAtIndex`/`cfiFromRange` 用 `try/catch` 收敛 epubjs 偶发抛错（不静默：上层据 null 退化，见 §错误处理），符合 spec §6。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误（epubjs 自带 types）。若报 `spine.length`/`section.document` 等类型不符，按 Step 1 核对的真实签名调整断言。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/epub-book.ts
git commit -m "feat(reader): add epubjs glue (createEpubBook: render/spine/CFI)"
```

---

## Task 4: `EpubReader` 骨架 + 替换 `ReaderPane`（手测：连续滚动）

**Files:**

- Modify: 根 `package.json`（加 `@marginalia/virtual-docs` 依赖）
- Create: `src/renderer/reader/EpubReader.tsx`
- Modify: `src/renderer/query/keys.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`

> 先把「取字节→解析→连续滚动渲染」跑通（暂不接 CFI/偏好/选区）。`EpubReader` 用 `useQuery(readEpubBytes)` 拿字节、`createEpubBook` 解析、渲染 `<VirtualDocs count loadSection/>`。替换 `ReaderView` 里的 `ReaderPane`。

- [ ] **Step 1: 主应用加包依赖**

```bash
pnpm add "@marginalia/virtual-docs@workspace:*"
pnpm db:rebuild:electron
```

Expected: 根 `package.json` `dependencies` 加 `"@marginalia/virtual-docs": "workspace:*"`；`db:rebuild:electron` 完成。（包是源码消费、无构建步，`workspace:*` 链接到 `packages/virtual-docs`。）

- [ ] **Step 2: 加 query keys** — `src/renderer/query/keys.ts` 的 `qk` 对象里加：

```ts
  epubBytes: (bookId: string) => ["epub-bytes", bookId] as const,
  progress: (bookId: string) => ["progress", bookId] as const,
```

- [ ] **Step 3: 写 `EpubReader.tsx`（骨架，仅渲染）**：

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";
import { qk } from "../query/keys";
import { createEpubBook, type EpubBook } from "./epub-book";

interface Props {
  bookId: string;
}

export function EpubReader({ bookId }: Props) {
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const bytes = useQuery({
    queryKey: qk.epubBytes(bookId),
    queryFn: () => window.api.library.readEpubBytes({ bookId }),
    staleTime: Infinity,
  });

  // 字节就绪 → 解析为 EpubBook（解析失败显错误态，不崩）。
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
        if (alive) setParseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
    };
  }, [bytes.data]);

  if (bytes.isError) {
    return <ReaderError message="无法读取此书的文件。" />;
  }
  if (parseError) {
    return <ReaderError message={`无法渲染此书：${parseError}`} />;
  }
  if (!book) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">载入中…</div>
    );
  }

  return (
    <div className="h-full">
      <VirtualDocs ref={vRef} count={book.count} loadSection={book.loadSection} />
    </div>
  );
}

function ReaderError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
```

> `window.api.library.readEpubBytes` 由 Task 1 暴露。`loadSection` 直接传 `book.loadSection`（引用稳定——`book` 仅在解析后 set 一次；满足 `@marginalia/virtual-docs` 对 `loadSection` 引用稳定的要求，见包 JSDoc）。

- [ ] **Step 4: 替换 `ReaderView` 的 `ReaderPane`** — `src/renderer/reader/ReaderView.tsx`：

把 import `import { ReaderPane } from "./ReaderPane";` 改为 `import { EpubReader } from "./EpubReader";`，并把渲染处

```tsx
<ReaderPane bookId={bookId} chapterId={chapterId} title={currentTitle} />
```

改为（`EpubReader` 只需 `bookId`，章节导航在 Task 5 接）：

```tsx
<EpubReader bookId={bookId} />
```

> `bookId` 在 `ReaderView` 内的来源不变（recon：`currentBookId`，`bookId != null` 时才渲染 reader 主体）。`chapterId`/`currentTitle`/章节列表查询保留（ChapterList 仍用），Task 5 再把 `currentChapterId` 接进 `EpubReader`。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/renderer/query/keys.ts src/renderer/reader/EpubReader.tsx src/renderer/reader/ReaderView.tsx
git commit -m "feat(reader): render real ePub via VirtualDocs in EpubReader, replace ReaderPane"
```

- [ ] **Step 7: 【手测检查点】真书连续滚动 + 内存有界**

> ⚠️ 由人执行。subagent 在此停下并提示。

```bash
pnpm start
```

导入/打开一本真实 ePub，验收：

- **真实渲染**：排版/字体/**图片**正确显示（不是纯文本）。若图片不显示 → epubjs `section.render` 未替换资源 URL，需在 `epub-book.loadSection` 改用 `book.resources` 替换图片/CSS URL 后再 serialize（记录现象，按需在 Task 3 的 `loadSection` 内补资源替换）。
- **连续滚动**：整本上下滚顺滑，每个 spine 项真实渲染。
- **内存有界**：DevTools → Elements，滚动时 iframe 数量维持小窗口（不随滚动累积到全 spine 数）。
- **错误态**：导入一本坏 ePub（或临时改 `readEpubBytes` 抛错）→ 显错误文案、不白屏不崩。

---

## Task 5: CFI 进度 + 恢复 + 跳章 + 当前章（手测）

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

> 接 4 件事：① `onTopIndexChange` → `hrefAtIndex` → `chapterIdByHref` → `setCurrentChapter`（当前章高亮）+ 防抖 `progress.save(cfiAtIndex)`；② 开书 `progress.get` → `indexOfCfi` → `initialIndex`（恢复）；③ `currentChapterId` 变化（ChapterList 点击）→ `indexOfHref` → `scrollToIndex`（跳章）；④ 防「滚动更新当前章」与「点击跳章」互相触发的循环（用 ref 记录最近一次由滚动得到的 index）。

- [ ] **Step 1: 给 `EpubReader` 接 CFI/进度/章节** — 替换 Task 4 的 `EpubReader.tsx` 整个组件实现为：

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";
import type { ChapterRefDto } from "@shared/library";
import { useReaderStore } from "../store/reader-store";
import { qk } from "../query/keys";
import { chapterIdByHref } from "./chapter-id-by-href";
import { createEpubBook, type EpubBook } from "./epub-book";

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
}

const SAVE_DEBOUNCE_MS = 1000;

export function EpubReader({ bookId, chapters }: Props) {
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const currentChapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);

  // 防循环：记录最近一次「由滚动得出的顶部章 id」；跳章 effect 只在目标≠它时滚动。
  const topChapterIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bytes = useQuery({
    queryKey: qk.epubBytes(bookId),
    queryFn: () => window.api.library.readEpubBytes({ bookId }),
    staleTime: Infinity,
  });

  // 恢复位置：进度 CFI → spine index（开书时取一次）。
  const progress = useQuery({
    queryKey: qk.progress(bookId),
    queryFn: () => window.api.progress.get({ bookId }),
    staleTime: Infinity,
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
        if (alive) setParseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
    };
  }, [bytes.data]);

  // 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到对应 spine index。
  useEffect(() => {
    if (!book || currentChapterId == null) return;
    if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
    const ch = chapters.find((c) => c.id === currentChapterId);
    if (!ch) return;
    const idx = book.indexOfHref(ch.href);
    if (idx >= 0) vRef.current?.scrollToIndex(idx);
  }, [book, currentChapterId, chapters]);

  // 恢复初始位置：进度 CFI → index（仅在 book+progress 就绪时算一次初值）。
  const initialIndex =
    book && progress.data?.cfi != null
      ? (() => {
          const i = book.indexOfCfi(progress.data.cfi);
          return i >= 0 ? i : 0;
        })()
      : 0;

  const onTopIndexChange = (index: number) => {
    if (!book) return;
    // 当前章高亮
    const href = book.hrefAtIndex(index);
    const chId = href ? chapterIdByHref(chapters, href) : null;
    if (chId) {
      topChapterIdRef.current = chId;
      if (chId !== currentChapterId) setCurrentChapter(chId);
    }
    // 防抖存进度（section 级 CFI）
    const cfi = book.cfiAtIndex(index);
    if (cfi) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.api.progress.save({ bookId, cfi });
      }, SAVE_DEBOUNCE_MS);
    }
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  if (bytes.isError) return <ReaderError message="无法读取此书的文件。" />;
  if (parseError) return <ReaderError message={`无法渲染此书：${parseError}`} />;
  // 等字节+进度都就绪再挂 VirtualDocs，使 initialIndex 一次到位（避免先 0 再跳）。
  if (!book || progress.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">载入中…</div>
    );
  }

  return (
    <div className="h-full">
      <VirtualDocs
        ref={vRef}
        count={book.count}
        loadSection={book.loadSection}
        initialIndex={initialIndex}
        onTopIndexChange={onTopIndexChange}
      />
    </div>
  );
}

function ReaderError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
```

> `setCurrentChapter`/`currentChapterId` 来自 `reader-store`（recon 确认）。ChapterList 点击已 `setCurrentChapter(ch.id)`（不变）——跳章 effect 监听该 id 滚动。`onTopIndexChange` 反向更新 id 时先写 `topChapterIdRef`，使跳章 effect 跳过（防循环）。`initialIndex` 在 `book`+`progress` 就绪后计算并一次性传入 VirtualDocs。

- [ ] **Step 2: `ReaderView` 传 `chapters` 给 `EpubReader`** — `src/renderer/reader/ReaderView.tsx`：把 `<EpubReader bookId={bookId} />` 改为：

```tsx
<EpubReader bookId={bookId} chapters={chapters.data ?? []} />
```

> `chapters` 是 `ReaderView` 已有的 `useQuery(qk.chapters(...))`（recon 确认）。仅当 `chapters.data` 就绪时其内容非空；空数组时当前章/跳章不生效（无害，等数据到再 re-render）。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/EpubReader.tsx src/renderer/reader/ReaderView.tsx
git commit -m "feat(reader): CFI progress save/restore, jump-to-chapter, current-chapter highlight"
```

- [ ] **Step 5: 【手测检查点】**

```bash
pnpm start
```

验收：

- **当前章高亮**：滚动时 ChapterList 高亮随顶部 section 所属章更新。
- **跳章**：点 ChapterList 条目 → 正文滚到该章；不出现「滚一下又弹回」的循环。
- **重开恢复**：滚到中部，等 1s（防抖存盘），关闭并重开此书 → 回到大致同一章（section 级，非像素级精确——段内精度见 Backlog）。
- **边界**：spine 项不在 ChapterList（如封面/版权页）时，顶部高亮可能短暂落空（可接受）。

---

## Task 6: 偏好注入 CSS（手测）

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

> `reader-store.prefs`（fontScale/lineHeight/maxWidth）经 `prefsToCss` → `styleCss` 传 `VirtualDocs` → 注入每个 iframe。偏好变更 → 新 `styleCss` → 包重载 iframe（包当前对 `styleCss` 变更重载 iframe，见 Plan A `SectionFrame`）→ 高度重测重锚。

- [ ] **Step 1: 接偏好** — `src/renderer/reader/EpubReader.tsx`：

加 import：

```tsx
import { prefsToCss } from "./prefs-to-css";
```

在组件内（与其它 `useReaderStore` 选择器并列）加：

```tsx
const prefs = useReaderStore((s) => s.prefs);
```

并把 `<VirtualDocs .../>` 加上 `styleCss`：

```tsx
<VirtualDocs
  ref={vRef}
  count={book.count}
  loadSection={book.loadSection}
  styleCss={prefsToCss(prefs)}
  initialIndex={initialIndex}
  onTopIndexChange={onTopIndexChange}
/>
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): inject reader prefs as CSS into ePub sections"
```

- [ ] **Step 4: 【手测检查点】**

```bash
pnpm start
```

验收：调 header 的字号/行距/宽度（`ReaderPrefs` 控件）→ 正文实时变化（字号百分比、行距、正文限宽居中）。

> 已知：`styleCss` 变更会重载 iframe（轻微闪），偏好变更不频繁可接受；若手测发现明显抖动，记入 Backlog（热更新注入 style，已在 ROADMAP 高度稳定性项附近）。

---

## Task 7: 选区桥 RA2 迁移（手测端到端 AI）

**Files:**

- Modify: `src/renderer/types.ts`
- Create: `src/renderer/reader/epub-selection.ts`
- Modify: `src/renderer/reader/EpubReader.tsx`

> 删 `useSelection`（静态 DOM）的活由包 `onSelect` 接管：在事件的 `doc`/`range`（iframe 内）上做**块级取段**（书的原生 HTML、无 `data-paragraph`→取最近块级祖先 + 相邻块级兄弟），产出 `SelectionInfo` 老形状（4 文本字段 + viewport `rect`）+ `cfiRange`（`epub-book.cfiFromRange`）→ `setSelection`。下游 `useAiActions`/`SelectionToolbar`/`AIPanel`/`Composer` **一行不改**。

- [ ] **Step 1: `SelectionInfo` 加 `cfiRange`** — `src/renderer/types.ts`：在 `SelectionInfo` 接口里加（放在 `rect` 之后）：

```ts
/** 选区的 CFI range（RA1-full 落点，供未来 RA3 标注；AI chips 不需要）。 */
cfiRange: string | null;
```

- [ ] **Step 2: 写 `epub-selection.ts`**：

```ts
import type { SectionSelectEvent } from "@marginalia/virtual-docs";
import type { SelectionInfo } from "../types";

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "BLOCKQUOTE",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "FIGCAPTION",
  "TD",
  "TH",
]);

/** 取 node 最近的块级祖先元素（含自身）。 */
function blockAncestor(node: Node): Element | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    if (BLOCK_TAGS.has((el as Element).tagName)) return el as Element;
    el = el.parentNode;
  }
  return null;
}

/** 相邻块级兄弟的文本（跳过空白文本节点）。 */
function siblingBlockText(el: Element, dir: "previous" | "next"): string | null {
  let sib: Element | null = dir === "previous" ? el.previousElementSibling : el.nextElementSibling;
  while (sib) {
    const t = (sib.textContent ?? "").trim();
    if (t.length > 0) return t;
    sib = dir === "previous" ? sib.previousElementSibling : sib.nextElementSibling;
  }
  return null;
}

/**
 * 把包的 onSelect 事件转成 SelectionInfo（AI 契约老形状 + cfiRange）。
 * 块级取段：当前段 = 选区起点的最近块级祖先文本；前/后段 = 其相邻块级兄弟。
 * 提取失败时 best-effort 退化为「只发选中文本」（绝不静默吞掉提问，spec §6）。
 */
export function sectionSelectToSelectionInfo(
  e: SectionSelectEvent,
  cfiRange: string | null,
): SelectionInfo {
  const block = blockAncestor(e.range.startContainer);
  const paragraphCurrent = (block?.textContent ?? e.text).trim();
  const paragraphBefore = block ? siblingBlockText(block, "previous") : null;
  const paragraphAfter = block ? siblingBlockText(block, "next") : null;
  return {
    selectionText: e.text,
    paragraphBefore,
    paragraphCurrent: paragraphCurrent.length > 0 ? paragraphCurrent : e.text,
    paragraphAfter,
    rect: e.rect, // 包已平移为 viewport 坐标（ViewportRect 与 SelectionInfo.rect 同形）
    cfiRange,
  };
}
```

> `SectionSelectEvent`/`ViewportRect` 从 `@marginalia/virtual-docs` 导出。`e.rect` 形状 `{x,y,width,height}` 与 `SelectionInfo.rect` 完全一致——直接赋值。`paragraphOf` 逻辑对应原 `useSelection` 的 `data-paragraph`，这里换成「最近块级祖先」（书的原生 HTML 无标记）。

- [ ] **Step 3: `EpubReader` 接选区** — `src/renderer/reader/EpubReader.tsx`：

加 import：

```tsx
import type { SectionSelectEvent } from "@marginalia/virtual-docs";
import { sectionSelectToSelectionInfo } from "./epub-selection";
```

在组件内加 store 选择器：

```tsx
const setSelection = useReaderStore((s) => s.setSelection);
```

加事件处理（与 `onTopIndexChange` 并列）：

```tsx
const onSelect = (e: SectionSelectEvent) => {
  const cfiRange = book ? book.cfiFromRange(e.index, e.range) : null;
  setSelection(sectionSelectToSelectionInfo(e, cfiRange));
};
const onSelectionCleared = () => setSelection(null);
```

并把 `<VirtualDocs .../>` 加上两个回调：

```tsx
<VirtualDocs
  ref={vRef}
  count={book.count}
  loadSection={book.loadSection}
  styleCss={prefsToCss(prefs)}
  initialIndex={initialIndex}
  onTopIndexChange={onTopIndexChange}
  onSelect={onSelect}
  onSelectionCleared={onSelectionCleared}
/>
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/types.ts src/renderer/reader/epub-selection.ts src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): bridge ePub selection to SelectionInfo + cfiRange (RA2 migration)"
```

- [ ] **Step 6: 【手测检查点】端到端 AI**

```bash
pnpm start
```

验收：

- 在真实渲染正文里划选 → `SelectionToolbar` 浮在选区上方（`rect` 视口坐标正确）。
- 点「解释/翻译/概括」→ AIPanel 出现 chips（选区 + 段落上下文）→ 发送 → 真模型流式回复。
- 跨多段选 → `paragraphCurrent` 含选中块、`before`/`after` 为相邻块（验证块级取段对原生 HTML 生效）。
- 划空/点别处 → 工具栏消失（`setSelection(null)`）。

---

## Task 8: 错误态收尾 + 删 `ReaderPane`/`useSelection`

**Files:**

- Delete: `src/renderer/reader/ReaderPane.tsx`
- Delete: `src/renderer/reader/useSelection.ts`
- Modify: `src/renderer/query/keys.ts`（删 `qk.chapter`，若无其它引用）

> RA1-min 的静态渲染产物退场。错误态在 `EpubReader`（Task 4/5）已覆盖（字节失败/解析失败显错误文案；单 section 失败由包内 `loadSection.catch` 占位，见 Plan A）。

- [ ] **Step 1: 确认 `ReaderPane`/`useSelection`/`qk.chapter` 无残留引用**

Run: `grep -rn "ReaderPane\|useSelection\|qk.chapter\b" src/renderer/ | grep -v "EpubReader\|ReaderView"`
Expected: 仅 `ReaderPane.tsx`/`useSelection.ts` 自身 + 其互相引用。若 `ReaderView.tsx` 仍 import `ReaderPane`，说明 Task 4 未替换干净——回查。`qk.chapter` 仅 `ReaderPane` 用（recon 确认 chapter text 查询），删 `ReaderPane` 后应无引用。

- [ ] **Step 2: 删文件**

```bash
git rm src/renderer/reader/ReaderPane.tsx src/renderer/reader/useSelection.ts
```

- [ ] **Step 3: 删 `qk.chapter`（确认无引用后）** — `src/renderer/query/keys.ts`：删除这一行：

```ts
  chapter: (bookId: string, chapterId: string) => ["chapter", bookId, chapterId] as const,
```

> 仅当 Step 1 确认 `qk.chapter` 无其它引用时删。`qk.chapters`（章节列表）保留——ChapterList/ReaderView 仍用。`content.chapterText` IPC/主进程**不动**（AI 工具仍用）。

- [ ] **Step 4: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -4`
Expected: typecheck 无错误；全量测试通过（含新增 `book-bytes`/`chapter-id-by-href`/`prefs-to-css` 用例，旧 `ReaderPane`/`useSelection` 无测试可删）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(reader): remove static ReaderPane/useSelection and dead query key"
```

- [ ] **Step 6: 【手测检查点】各错误态 + 回归**

```bash
pnpm start
```

验收：

- 坏 ePub → 「无法渲染此书」错误态，不崩。
- `readEpubBytes` 失败（临时改 path）→ 「无法读取此书的文件」。
- 单 section 渲染失败 → 该项占位「本节加载失败」，其余照常滚动（包内行为）。
- 回归：连续滚动 / 跳章 / 当前章 / 恢复 / 偏好 / 选区→AI 全部仍正常。

---

## 完成后

- 全部 8 任务过 + 各手测检查点通过后，**RA1-full** 即落地：真实 ePub 连续滚动渲染、内存有界、CFI 进度/跳章/当前章、偏好注入、选区→AI（CFI 已捕获存 `cfiRange`，供 RA3 标注）。
- 走 `finishing-a-development-branch` 合并；合并时更新 ROADMAP：RA1-full → ✅、RA2 → ✅（CFI 选区落地）、`SelectionInfo.cfiRange` 标记 RA3 就绪。
- 解锁 **RA3 + M-b**（标注：依赖 `cfiRange`）。

## 刻意推迟（不在本计划，记/已在 Backlog）

- **CFI 段内精度**（进度精确到滚动位置/段，本计划 section 级恢复到章）。
- **epub.js section 内存释放**（`section.unload` 当 virtuoso 卸载项时；本计划解析后常驻 `section.document` 供 CFI——长书 JS 堆可能涨，与 ROADMAP「高度稳定性/内存」项一并优化）。
- **虚拟滚动高度稳定性**（向上滚闪 + 图片高度跳变，已在 ROADMAP Backlog；真实 ePub 上针对性调）。
- 子 section 切块（超大单 spine 项）· 标注渲染/持久化（RA3）· 分页/翻页 · 搜索 · 暗色主题 · chip「跳回原文」· 跨章选区→独立会话（M-c/RA4）· 嵌套 TOC（spec §8）。
