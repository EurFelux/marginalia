# PDF 支持 PDF-P1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Marginalia 能导入并阅读 PDF：pdf-parser 包（解析/文本/页渲染）、schema 迁移（format/页范围/locator 改名）、导入魔数分发（含封面）、PdfReader canvas 渲染（虚拟化 + 适宽/档位缩放 + 暗色滤镜）、进度 locator、扫描版检测。

**Architecture:** 双引擎并立（epubjs / pdfjs-dist），Locator 黑盒（ePub 存裸 CFI、PDF 存 `pdf:`+JSON），pdfjs 双端（主进程 legacy build 解析提取、渲染层标准 build + worker 画 canvas）。spec：`docs/superpowers/specs/2026-06-06-pdf-support-design.md`。

**Tech Stack:** pdfjs-dist 6.x（legacy + worker 双端）、@napi-rs/canvas（NAPI，免 electron-rebuild）、react-virtuoso、pdf-lib（仅 fixture devDep）、Drizzle 迁移、vitest（Electron 运行时）。

**通用注意：**

- 全程在分支 `feat/pdf-support` 上开发，不碰 main。
- `git commit` 触发 prek（lint:fix + format），若报 "files were modified by this hook"：重新 `git add` 被改文件、原命令再跑一次即可。
- `pnpm add` 之后 postinstall 会自动把 better-sqlite3 翻回 Electron ABI；装完跑一次 `pnpm test` 确认绿即可，无需手动翻转。
- i18n：改 `t()` 默认值后跑 `pnpm i18n:extract`，然后手动更新 `src/shared/i18n/locales/en.ts` 对应键的英文（extract 只同步主语言 zh-CN）。

---

### Task 0: 建分支 + 安装依赖

**Files:**

- Modify: `package.json`（根，依赖追加）

- [ ] **Step 1: fetch 并建分支**（本地 main 工作流要求开工先 fetch）

```bash
git fetch origin
git switch -c feat/pdf-support main
```

- [ ] **Step 2: 安装运行时依赖**

```bash
pnpm add pdfjs-dist @napi-rs/canvas react-virtuoso
```

预期：pdfjs-dist ^6.0.x、@napi-rs/canvas ^1.0.0、react-virtuoso ^4.18.x 进根 `dependencies`；postinstall 自动跑 `db:rebuild:electron`。

- [ ] **Step 3: 验证 ABI 未被破坏**

Run: `pnpm test`
Expected: 既有全部测试 PASS（确认 better-sqlite3 仍为 Electron ABI）。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add pdfjs-dist, @napi-rs/canvas, react-virtuoso for pdf support"
```

---

### Task 1: pdf-parser 包骨架 + PDF fixture 构造器

**Files:**

- Create: `packages/pdf-parser/package.json`
- Create: `packages/pdf-parser/tsconfig.json`
- Create: `packages/pdf-parser/src/index.ts`
- Create: `packages/pdf-parser/src/types.ts`
- Create: `packages/pdf-parser/src/fixture.ts`
- Test: `packages/pdf-parser/src/fixture.test.ts`
- Modify: `vitest.config.ts`（include 收编 packages 测试）

- [ ] **Step 1: 包骨架**

`packages/pdf-parser/package.json`：

```json
{
  "name": "@marginalia/pdf-parser",
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
  "dependencies": {
    "pdfjs-dist": "^6.0.227",
    "@napi-rs/canvas": "^1.0.0"
  },
  "devDependencies": {
    "pdf-lib": "^1.17.1",
    "typescript": "~6.0.3",
    "vitest": "^4.1.7"
  }
}
```

`packages/pdf-parser/tsconfig.json`（照抄 epub-parser）：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src"]
}
```

`packages/pdf-parser/src/types.ts`：

```ts
/** 与 @marginalia/epub-parser 的 TocNode 同形（结构类型兼容，不引依赖）。 */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

/** 章节页范围（1-based 闭区间），与 toc 同序号对应（toc[i].href === "pdf-ch:i"）。 */
export interface ChapterRange {
  startPage: number;
  endPage: number;
}

/** parsePdf 的产物。 */
export interface ParsedPdf {
  title?: string;
  author?: string;
  pageCount: number;
  /** outline 压扁后的目录；无 outline 时为 []（消费方退化为单章）。 */
  toc: TocNode[];
  /** 章节页范围；无 outline 时为 [{ startPage: 1, endPage: pageCount }]。 */
  chapterRanges: ChapterRange[];
  /** 文本层检测：采样前 8 页平均字符数 < 阈值 → false（扫描版）。 */
  hasTextLayer: boolean;
}

/** 与 epub-parser 的 ChapterTextSlice 同形（结构类型兼容）。 */
export interface ChapterTextSlice {
  text: string;
  hasMore: boolean;
  nextOffset: number;
}
```

`packages/pdf-parser/src/index.ts`（先只导出 fixture 与类型，后续任务逐步追加）：

```ts
export { makeTextPdf, makeScannedPdf } from "./fixture";
export type { ParsedPdf, TocNode, ChapterRange, ChapterTextSlice } from "./types";
```

- [ ] **Step 2: 装包内 devDep**

```bash
pnpm --filter @marginalia/pdf-parser install
```

（workspace 已含 `packages/*`，pnpm 会解析新包并装 pdf-lib。）

- [ ] **Step 3: fixture 构造器**

`packages/pdf-parser/src/fixture.ts`：

```ts
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";

/** 每页正文模板：page N 的文本（fixture 断言用，足够长以通过文本层检测阈值）。 */
export function fixturePageText(page: number): string {
  return `This is the body text of page ${page}. `.repeat(4).trim();
}

interface TextPdfOptions {
  /** 是否带 outline（两章：Chapter One → p1，Chapter Two → p3）。 */
  outline: boolean;
  title?: string;
  author?: string;
  pages?: number; // 默认 3
}

/**
 * 文字版 fixture：每页 drawText（有文本层）。
 * outline=true 时写入低层 /Outlines 字典（pdf-lib 无高层 API）：
 * Dest 数组首元素为页 ref，pdfjs 经 getPageIndex(ref) 解析回页号。
 */
export async function makeTextPdf(opts: TextPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageCount = opts.pages ?? 3;
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(fixturePageText(i), { x: 40, y: 560, size: 12, font, maxWidth: 320 });
  }

  if (opts.outline) {
    const ctx = doc.context;
    const pageRefs = doc.getPages().map((p) => p.ref);
    const entries = [
      { title: "Chapter One", pageIndex: 0 },
      { title: "Chapter Two", pageIndex: 2 },
    ];
    const outlinesRef = ctx.nextRef();
    const itemRefs = entries.map(() => ctx.nextRef());
    entries.forEach((e, i) => {
      const item: Record<string, unknown> = {
        Title: PDFHexString.fromText(e.title),
        Parent: outlinesRef,
        Dest: [pageRefs[e.pageIndex]!, PDFName.of("XYZ"), null, null, null],
      };
      if (i > 0) item.Prev = itemRefs[i - 1];
      if (i < entries.length - 1) item.Next = itemRefs[i + 1];
      ctx.assign(itemRefs[i]!, ctx.obj(item));
    });
    ctx.assign(
      outlinesRef,
      ctx.obj({
        Type: "Outlines",
        First: itemRefs[0]!,
        Last: itemRefs[itemRefs.length - 1]!,
        Count: entries.length,
      }),
    );
    doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  }

  return doc.save({ useObjectStreams: false });
}

/** 扫描版 fixture：3 张空页（无任何文本绘制 → getTextContent 为空 → hasTextLayer=false）。 */
export async function makeScannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 600]);
  return doc.save({ useObjectStreams: false });
}
```

- [ ] **Step 4: fixture 自检测试**

`packages/pdf-parser/src/fixture.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeScannedPdf, makeTextPdf } from "./fixture";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

describe("pdf fixtures", () => {
  it("makeTextPdf produces a PDF byte stream", async () => {
    const bytes = await makeTextPdf({ outline: true, title: "Fixture Book" });
    expect(Array.from(bytes.slice(0, 5))).toEqual(PDF_MAGIC);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("makeScannedPdf produces a PDF byte stream", async () => {
    const bytes = await makeScannedPdf();
    expect(Array.from(bytes.slice(0, 5))).toEqual(PDF_MAGIC);
  });
});
```

- [ ] **Step 5: 收编 packages 测试进根套件**

`vitest.config.ts` 的 `test.include` 改为：

```ts
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
```

（同时收编 epub-parser 既有测试——它此前不在根套件内。ui-prototype 不在 workspace、不含 `src/*.test.ts`，不受影响。）

- [ ] **Step 6: 跑测试验证**

Run: `pnpm test`
Expected: PASS，且测试列表中出现 `packages/pdf-parser/src/fixture.test.ts` 与 `packages/epub-parser/src/*.test.ts`。若 epub-parser 既有测试意外失败：把 include 收窄为 `packages/pdf-parser/src/**/*.test.ts` 并在 commit message 记录原因。

- [ ] **Step 7: Commit**

```bash
git add packages/pdf-parser vitest.config.ts pnpm-lock.yaml
git commit -m "feat(pdf-parser): package skeleton with pdf-lib fixtures"
```

---

### Task 2: parsePdf（元数据 + outline→章节 + 扫描版检测）

**Files:**

- Create: `packages/pdf-parser/src/parse.ts`
- Test: `packages/pdf-parser/src/parse.test.ts`
- Modify: `packages/pdf-parser/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/pdf-parser/src/parse.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeScannedPdf, makeTextPdf } from "./fixture";
import { parsePdf } from "./parse";

describe("parsePdf", () => {
  it("reads metadata, pageCount and detects text layer", async () => {
    const bytes = await makeTextPdf({ outline: false, title: "Fixture Book", author: "Tester" });
    const parsed = await parsePdf(bytes);
    expect(parsed.title).toBe("Fixture Book");
    expect(parsed.author).toBe("Tester");
    expect(parsed.pageCount).toBe(3);
    expect(parsed.hasTextLayer).toBe(true);
  });

  it("maps outline to flat toc + chapterRanges", async () => {
    const bytes = await makeTextPdf({ outline: true });
    const parsed = await parsePdf(bytes);
    expect(parsed.toc).toEqual([
      { label: "Chapter One", href: "pdf-ch:0" },
      { label: "Chapter Two", href: "pdf-ch:1" },
    ]);
    // Chapter One: p1–p2（下一章起点-1）；Chapter Two: p3–末页
    expect(parsed.chapterRanges).toEqual([
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 3 },
    ]);
  });

  it("falls back to single whole-book chapter when no outline", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const parsed = await parsePdf(bytes);
    expect(parsed.toc).toEqual([]);
    expect(parsed.chapterRanges).toEqual([{ startPage: 1, endPage: 3 }]);
  });

  it("detects scanned pdf (no text layer)", async () => {
    const bytes = await makeScannedPdf();
    const parsed = await parsePdf(bytes);
    expect(parsed.hasTextLayer).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test packages/pdf-parser/src/parse.test.ts`
Expected: FAIL（`parse.ts` 不存在）。

- [ ] **Step 3: 实现 parsePdf**

`packages/pdf-parser/src/parse.ts`：

```ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ChapterRange, ParsedPdf, TocNode } from "./types";

/** 文本层检测：采样页平均字符数低于此阈值 → 视为扫描版。 */
const TEXT_LAYER_MIN_AVG_CHARS = 50;
const TEXT_LAYER_SAMPLE_PAGES = 8;

/**
 * 打开 PDF 文档。pdfjs 会 transfer 传入 buffer（之后原数组不可用），
 * 故一律传副本；isEvalSupported:false 关掉字体代码 eval（沙箱友好）。
 */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

/** 单页纯文本：items.str 拼接，hasEOL 处换行。 */
export async function pageText(doc: PDFDocumentProxy, pageNo: number): Promise<string> {
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  let out = "";
  for (const item of tc.items) {
    if ("str" in item) {
      out += item.str;
      if (item.hasEOL) out += "\n";
    }
  }
  page.cleanup();
  return out;
}

interface FlatOutlineEntry {
  title: string;
  pageIndex: number; // 0-based
}

/** outline 压扁 + dest → 页号解析（named destination 经 getDestination 间接解析）。 */
async function flattenOutline(doc: PDFDocumentProxy): Promise<FlatOutlineEntry[]> {
  const outline = await doc.getOutline();
  if (!outline || outline.length === 0) return [];
  const flat: FlatOutlineEntry[] = [];
  type OutlineItem = (typeof outline)[number];
  const walk = async (items: OutlineItem[]): Promise<void> => {
    for (const item of items) {
      const explicit =
        typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      const ref = explicit?.[0];
      if (ref != null) {
        try {
          const pageIndex = await doc.getPageIndex(ref);
          if (item.title) flat.push({ title: item.title, pageIndex });
        } catch {
          // dest 指向不存在的页（畸形书）：跳过该条目，不让整书导入失败。
        }
      }
      if (item.items?.length) await walk(item.items);
    }
  };
  await walk(outline);
  // 起始页须单调不减（按阅读顺序）；个别乱序条目按起始页排序兜底。
  flat.sort((a, b) => a.pageIndex - b.pageIndex);
  return flat;
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const doc = await openPdf(bytes);
  try {
    const pageCount = doc.numPages;

    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: string; Author?: string };
    const title = info.Title?.trim() || undefined;
    const author = info.Author?.trim() || undefined;

    // 扫描版检测：前 N 页平均字符数。
    const sample = Math.min(TEXT_LAYER_SAMPLE_PAGES, pageCount);
    let chars = 0;
    for (let p = 1; p <= sample; p++) chars += (await pageText(doc, p)).length;
    const hasTextLayer = sample > 0 && chars / sample >= TEXT_LAYER_MIN_AVG_CHARS;

    const flat = await flattenOutline(doc);
    let toc: TocNode[];
    let chapterRanges: ChapterRange[];
    if (flat.length > 0) {
      toc = flat.map((e, i) => ({ label: e.title, href: `pdf-ch:${i}` }));
      chapterRanges = flat.map((e, i) => ({
        startPage: e.pageIndex + 1,
        endPage: i + 1 < flat.length ? flat[i + 1]!.pageIndex : pageCount,
      }));
      // endPage = 下一章起始页 - 1，但若同页起章（下一章同页）至少含起始页本身。
      chapterRanges = chapterRanges.map((r, i) => ({
        startPage: r.startPage,
        endPage: i + 1 < chapterRanges.length ? Math.max(r.startPage, r.endPage) : r.endPage,
      }));
    } else {
      toc = [];
      chapterRanges = [{ startPage: 1, endPage: pageCount }];
    }

    return { title, author, pageCount, toc, chapterRanges, hasTextLayer };
  } finally {
    await doc.destroy();
  }
}
```

注意：`chapterRanges` 的 endPage 语义是「下一章起始页 − 1，至少为本章起始页」——上面 map 里 `endPage: flat[i+1].pageIndex`（0-based 的下一章起点 = 1-based 的下一章起点 − 1），已是正确值；`Math.max` 兜同页起章。若 TS 对 `pdfjs-dist/legacy/build/pdf.mjs` 的类型解析报错（exports types 缺失），在文件顶部用 `// @ts-expect-error pdfjs legacy build lacks type mapping` 标注该 import 并继续（运行时正确），同时把 `PDFDocumentProxy` 类型改从 `pdfjs-dist` 主入口 import type。

- [ ] **Step 4: 导出**

`packages/pdf-parser/src/index.ts` 追加：

```ts
export { parsePdf, openPdf, pageText } from "./parse";
```

- [ ] **Step 5: 跑测试**

Run: `pnpm test packages/pdf-parser/src/parse.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/pdf-parser
git commit -m "feat(pdf-parser): parsePdf with outline mapping and scanned detection"
```

---

### Task 3: extractPdfText（页范围 + 页边界标记 + 字符切片）

**Files:**

- Create: `packages/pdf-parser/src/content.ts`
- Test: `packages/pdf-parser/src/content.test.ts`
- Modify: `packages/pdf-parser/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/pdf-parser/src/content.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { extractPdfText } from "./content";
import { fixturePageText, makeTextPdf } from "./fixture";

describe("extractPdfText", () => {
  it("extracts page range with page-boundary markers", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const slice = await extractPdfText(bytes, { startPage: 1, endPage: 2 });
    expect(slice.text).toContain("[p.1]");
    expect(slice.text).toContain("[p.2]");
    expect(slice.text).not.toContain("[p.3]");
    // fixture 正文按词渲染，提取后空白形态可能不同——按首词断言
    expect(slice.text).toContain("body text of page 1");
    expect(slice.hasMore).toBe(false);
  });

  it("paginates by character offset", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const first = await extractPdfText(bytes, { startPage: 1, endPage: 3, maxChars: 80 });
    expect(first.text.length).toBe(80);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(80);
    const rest = await extractPdfText(bytes, {
      startPage: 1,
      endPage: 3,
      offset: first.nextOffset,
      maxChars: 100_000,
    });
    expect(rest.hasMore).toBe(false);
    // 拼回完整文本：与一次性读取一致
    const whole = await extractPdfText(bytes, { startPage: 1, endPage: 3, maxChars: 100_000 });
    expect(first.text + rest.text).toBe(whole.text);
  });
});
```

注：`fixturePageText` 在此文件 import 但首个断言未直接用——若 lint 报 unused import，删掉该 import。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test packages/pdf-parser/src/content.test.ts`
Expected: FAIL（content.ts 不存在）。

- [ ] **Step 3: 实现**

`packages/pdf-parser/src/content.ts`：

```ts
import { openPdf, pageText } from "./parse";
import type { ChapterTextSlice } from "./types";

export interface PdfReadOptions {
  startPage: number; // 1-based 闭区间
  endPage: number;
  offset?: number;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 20_000; // 与 epub-parser 对齐

/**
 * 提取页范围纯文本：页间插入页边界标记 `[p.N]`（spec §5.1——模型可在章节
 * 文本中引用页码并跳转 readPage 精读），再按字符偏移切片。
 * 注意：此处的 offset 是「章内偏移」（含标记），与标注 locator 的「页内偏移」
 * 是两个独立坐标空间，互不转换（spec §5.1 偏移空间注记）。
 */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: PdfReadOptions,
): Promise<ChapterTextSlice> {
  const { startPage, endPage, offset = 0, maxChars = DEFAULT_MAX_CHARS } = opts;
  const doc = await openPdf(bytes);
  try {
    const parts: string[] = [];
    const last = Math.min(endPage, doc.numPages);
    for (let p = Math.max(1, startPage); p <= last; p++) {
      const text = (await pageText(doc, p)).replace(/\s+/g, " ").trim();
      parts.push(`[p.${p}]`);
      if (text) parts.push(text);
    }
    const full = parts.join("\n\n");
    const text = full.slice(offset, offset + maxChars);
    const nextOffset = offset + text.length;
    return { text, hasMore: nextOffset < full.length, nextOffset };
  } finally {
    await doc.destroy();
  }
}
```

- [ ] **Step 4: 导出**

`packages/pdf-parser/src/index.ts` 追加：

```ts
export { extractPdfText } from "./content";
export type { PdfReadOptions } from "./content";
```

- [ ] **Step 5: 跑测试**

Run: `pnpm test packages/pdf-parser/src/content.test.ts`
Expected: 2 个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/pdf-parser
git commit -m "feat(pdf-parser): extractPdfText with page-boundary markers"
```

---

### Task 4: renderPageImage（@napi-rs/canvas → PNG）

**Files:**

- Create: `packages/pdf-parser/src/render.ts`
- Test: `packages/pdf-parser/src/render.test.ts`
- Modify: `packages/pdf-parser/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/pdf-parser/src/render.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeTextPdf } from "./fixture";
import { renderPageImage } from "./render";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("renderPageImage", () => {
  it("renders a page to PNG bytes", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const png = await renderPageImage(bytes, 1, { scale: 1 });
    expect(Array.from(png.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test packages/pdf-parser/src/render.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/pdf-parser/src/render.ts`：

```ts
import { openPdf } from "./parse";

export interface RenderOptions {
  /** 渲染倍率；省略时按 targetWidth 计算。 */
  scale?: number;
  /** 目标像素宽（如封面 600）；与 scale 二选一，scale 优先。 */
  targetWidth?: number;
}

/**
 * 渲染单页为 PNG（Node 环境：pdfjs v6 在 Node 下经 optionalDep @napi-rs/canvas
 * 自动提供 canvasFactory；文档代理上的 canvasFactory 未进公开 d.ts，按官方
 * examples/node/pdf2png 模式访问）。
 */
export async function renderPageImage(
  bytes: Uint8Array,
  pageNo: number,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = opts.scale ?? (opts.targetWidth ? opts.targetWidth / base.width : 1);
    const viewport = page.getViewport({ scale: Math.min(scale, 4) });
    const canvasFactory = (
      doc as unknown as {
        canvasFactory: {
          create: (
            w: number,
            h: number,
          ) => {
            canvas: { toBuffer: (mime: "image/png") => Buffer };
            context: unknown;
          };
        };
      }
    ).canvasFactory;
    const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
    await page.render({
      canvasContext: context as CanvasRenderingContext2D,
      viewport,
    }).promise;
    page.cleanup();
    return new Uint8Array(canvas.toBuffer("image/png"));
  } finally {
    await doc.destroy();
  }
}
```

- [ ] **Step 4: 导出**

`packages/pdf-parser/src/index.ts` 追加：

```ts
export { renderPageImage } from "./render";
export type { RenderOptions } from "./render";
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `pnpm test packages/pdf-parser/src/render.test.ts && pnpm typecheck`
Expected: PASS（若 `CanvasRenderingContext2D` 在 main tsconfig（无 DOM lib）下报错，把 cast 改为 `as never`）。

- [ ] **Step 6: Commit**

```bash
git add packages/pdf-parser
git commit -m "feat(pdf-parser): renderPageImage via @napi-rs/canvas"
```

---

### Task 5: schema 迁移（format / 页范围 / locator 改名）

**Files:**

- Modify: `src/main/db/schema.ts`
- Create: `src/main/db/migrations/<timestamp>_*/`（db:generate 产物）
- Test: `src/main/library/repository.test.ts`（追加断言）

- [ ] **Step 1: 改 schema**

`src/main/db/schema.ts` 的 `books` 表加三列（`addedAt` 之前）：

```ts
  // 文档格式判别：双引擎分发的依据（spec 2026-06-06-pdf-support §4）。
  format: text("format", { enum: ["epub", "pdf"] })
    .notNull()
    .default("epub"),
  pageCount: integer("page_count"), // PDF 专用；epub 为 null
  // 扫描版检测结果（导入时落库）；epub 恒 true。false ⇒ AI/标注功能门控。
  hasTextLayer: integer("has_text_layer", { mode: "boolean" }).notNull().default(true),
```

并在表配置数组（`books` 当前无表级配置，需把第二参数加上）：

```ts
export const books = sqliteTable(
  "books",
  {
    /* …原有列 + 上面三列… */
  },
  (t) => [check("books_format_check", sql`${t.format} in ('epub','pdf')`)],
);
```

`chapters` 表加两列（`summary` 之前）：

```ts
    startPage: integer("start_page"), // PDF 章节页范围（1-based 闭区间）；epub 为 null
    endPage: integer("end_page"),
```

`progress` 表：`cfi: text("cfi").notNull()` → `locator: text("locator").notNull()`。

`annotations` 表：`cfiRange: text("cfi_range").notNull()` → `locatorRange: text("locator_range").notNull()`。

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`

drizzle-kit 检测到列改名会交互询问——为 `cfi`→`locator` 与 `cfi_range`→`locator_range` 选择 **rename**（`~` 标记项），不要选 create+delete。

- [ ] **Step 3: 验证迁移 SQL**

Run: `cat src/main/db/migrations/<新目录>/migration.sql`
Expected: 含 `ALTER TABLE \`progress\` RENAME COLUMN`、`ALTER TABLE \`annotations\` RENAME COLUMN`（**不得**出现 progress/annotations 的 DROP TABLE/重建）；books/chapters 为 `ALTER TABLE ... ADD COLUMN`。books 的 CHECK 约束若触发表重建（SQLite 限制），确认重建 SQL 带 `INSERT INTO ... SELECT` 数据搬运且 FK 关系保留（参考既往 #9 P3a 表重建迁移；`runMigrations` 已在事务外关 FK）。

- [ ] **Step 4: 既有测试回归 + 新断言**

`src/main/library/repository.test.ts` 在导入用例中追加断言（找到现有 `importBook` 成功用例，紧随其后）：

```ts
// schema 默认值：epub 导入 format='epub'、hasTextLayer=true、pageCount=null
expect(row.format).toBe("epub");
expect(row.hasTextLayer).toBe(true);
expect(row.pageCount).toBeNull();
```

Run: `pnpm test`
Expected: 全部 PASS（`:memory:` 库每次跑全迁移链，等价验证迁移可执行）。注意 progress/annotations 相关既有测试此时会因字段改名编译失败——先把测试与实现里的 `cfi`/`cfiRange` 同步改名（`progress.ts` 的 `saveProgress(db, bookId, locator)`、`annotations.ts` 的字段），这是下一任务的 shared 改名的 main 侧先行部分；以 `pnpm typecheck` 红名单为清单逐个改绿。

- [ ] **Step 5: Commit**

```bash
git add src/main/db src/main/library
git commit -m "feat(db): book format/pageCount/hasTextLayer, chapter page ranges, locator rename"
```

---

### Task 6: shared 契约改名 + preload + renderer 机械同步

**Files:**

- Modify: `src/shared/library.ts`、`src/shared/annotations.ts`、`src/shared/ipc.ts`
- Modify: `src/preload.ts`
- Modify: `src/main/ipc/library-handlers.ts`、`src/main/ipc/annotations-handlers.ts`（如有）
- Modify: `src/renderer/query/keys.ts`（+ `keys.test.ts`）、`src/renderer/reader/EpubReader.tsx`、`src/renderer/reader/apply-annotations.ts`、`src/renderer/reader/epub-selection.ts` 及 typecheck 指出的其余消费点
- Modify: `src/renderer/library/LibraryView.tsx`

- [ ] **Step 1: shared 层改**

`src/shared/library.ts`：

```ts
export const saveProgressInput = z.object({
  bookId: z.string().min(1),
  locator: z.string().min(1),
});
```

`BookSummaryDto` 改为：

```ts
export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  hasCover: boolean;
  format: "epub" | "pdf";
  pageCount: number | null;
  hasTextLayer: boolean;
}
```

`ChapterRefDto` 追加两个字段：

```ts
export interface ChapterRefDto {
  id: string;
  title: string | null;
  href: string;
  orderIndex: number;
  level: number;
  startPage: number | null; // PDF 章节页范围；epub 为 null
  endPage: number | null;
}
```

`src/shared/annotations.ts`：`cfiRange` 全部改名 `locatorRange`（`createAnnotationInput`、`AnnotationDto` 等出现处）。

`src/shared/ipc.ts`：

```ts
  libraryPickBook: def("library:pick-book", "invoke", z.void(), out<string | null>()),
  libraryReadBookBytes: def("library:read-book-bytes", "invoke", bookIdInput, out<Uint8Array>()),
```

（替换原 `libraryPickEpub`/`libraryReadEpubBytes` 两条；`progressGet` 的 out 改 `out<{ locator: string } | null>()`。）

- [ ] **Step 2: typecheck 驱动机械改名**

Run: `pnpm typecheck`

按报错清单逐个改绿（预期波及）：

- `src/preload.ts`：`pickEpub` → `pickBook`、`readEpubBytes` → `readBookBytes`（invoker 契约引用同步）。
- `src/main/ipc/library-handlers.ts`：`C.libraryPickBook`（dialog filters 改 `[{ name: "Books", extensions: ["epub", "pdf"] }]`）、`C.libraryReadBookBytes`、`progressGet` 返回 `{ locator: p.locator }`、`progressSave` 传 `input.locator`、`toDto` 透传 `format`/`pageCount`/`hasTextLayer`（`listBooks` 的 select 见 Task 7 注：此处先在 `listBooks` select 中补 `format: books.format, pageCount: books.pageCount, hasTextLayer: books.hasTextLayer`）。
- annotations 的 main handler 与 repository：`cfiRange` → `locatorRange`。
- `src/renderer/query/keys.ts`：`epubBytes` → `bookBytes`（key 串 `"book-bytes"`）；`keys.test.ts` 同步。
- `src/renderer/reader/EpubReader.tsx`：`qk.bookBytes` / `window.api.library.readBookBytes` / `progress.data?.locator` / `progress.save({ bookId, locator: cfi })`。
- `src/renderer/reader/apply-annotations.ts`、`epub-selection.ts`、`SelectionToolbar.tsx`、`annotation-store.ts`、`AnnotationsList.tsx` 等：`cfiRange` → `locatorRange`（值仍是 CFI 串，仅改名）。
- `src/renderer/library/LibraryView.tsx`：`window.api.library.pickEpub()` → `pickBook()`。
- `listChapters`（`src/main/library/content.ts`）：两条返回路径补 `startPage`/`endPage`（TOC walk 路径 `startPage: ch.startPage, endPage: ch.endPage`——需要 `resolveChapterByHref` 返回行已含新列，`$inferSelect` 自动包含；spine 兜底路径 select 与 map 同步补）。

- [ ] **Step 3: 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "refactor(ipc): generalize epub-specific contracts to book/locator naming"
```

---

### Task 7: book-files 按格式泛化

**Files:**

- Modify: `src/main/library/book-files.ts`
- Test: `src/main/library/book-files.test.ts`
- Modify: `src/main/library/repository.ts`（deleteBook 签名）、`src/main/ipc/library-handlers.ts`、`src/main/ai/send-deps.ts` 等 loadBytes 注入点（typecheck 驱动）

- [ ] **Step 1: 写失败测试**

`src/main/library/book-files.test.ts` 追加：

```ts
it("derives pdf path with .pdf extension", () => {
  const p = storedBookPath("/tmp/books", "some-book", "pdf");
  expect(p.endsWith(".pdf")).toBe(true);
});

it("epub path stays byte-identical to the legacy derivation", () => {
  // 既有 .epub 副本的派生路径不得改变（编码函数永久稳定约定）
  expect(storedBookPath("/tmp/books", "id-1", "epub")).toBe(
    path.join("/tmp/books", createHash("sha256").update("id-1").digest("hex") + ".epub"),
  );
});
```

（按该测试文件现有 import 风格补 `path`/`createHash` import；既有用例中 `storedEpubPath(...)` 改为 `storedBookPath(..., "epub")`。）

- [ ] **Step 2: 实现泛化**

`src/main/library/book-files.ts`：

```ts
export type BookFormat = "epub" | "pdf";

export class BookFileMissingError extends Error {
  constructor(public readonly bookId: string) {
    super(`book file missing for book ${bookId}`);
    this.name = "BookFileMissingError";
  }
}

export function storedBookPath(booksDir: string, bookId: string, format: BookFormat): string {
  const name = createHash("sha256").update(bookId).digest("hex");
  return path.join(booksDir, `${name}.${format}`);
}

export async function writeBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(booksDir, { recursive: true });
  await writeFile(storedBookPath(booksDir, bookId, format), bytes);
}

export async function readBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(storedBookPath(booksDir, bookId, format)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new BookFileMissingError(bookId);
    throw err;
  }
}

export async function deleteBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
): Promise<void> {
  await unlink(storedBookPath(booksDir, bookId, format)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") console.warn(`[book-files] unlink ${bookId} failed:`, err);
  });
}
```

（旧名 `storedEpubPath`/`readEpubFile`/`writeEpubFile`/`deleteEpubFile`/`EpubFileMissingError` 直接删除，typecheck 驱动改调用方；既有 ePub 副本路径不变。）

- [ ] **Step 3: typecheck 驱动改调用方**

Run: `pnpm typecheck`

- `repository.ts` `deleteBook`：先查行拿 format 再删——

```ts
export async function deleteBook(db: DB, booksDir: string, bookId: string): Promise<void> {
  const book = getBook(db, bookId); // 删行前取 format（行删后取不到）
  db.delete(books).where(eq(books.id, bookId)).run();
  if (book) await deleteBookFile(booksDir, bookId, book.format);
}
```

- `library-handlers.ts`：`readBookFile(getBooksDir(), input.bookId, book.format)`（`libraryReadBookBytes` 与 `contentChapterText` 两处都先 `getBook` 拿 format；前者原本没查书，补 `const book = getBook(getDb(), input.bookId); if (!book) throw ...`）。
- `send-deps.ts` 等 `loadBytes` 工厂：同样先 `getBook` 取 format 再 `readBookFile`。
- 错误类引用处 `EpubFileMissingError` → `BookFileMissingError`。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。

```bash
git add src
git commit -m "refactor(library): format-aware book file storage"
```

---

### Task 8: importBook 魔数分发 + PDF 导入（含封面）

**Files:**

- Modify: `src/main/library/repository.ts`
- Test: `src/main/library/repository.test.ts`
- Modify: `src/main/ipc/library-handlers.ts`（import handler await + format）

- [ ] **Step 1: 写失败测试**

`src/main/library/repository.test.ts` 追加（fixture 用 `@marginalia/pdf-parser` 的构造器）：

```ts
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser";

describe("importBook (pdf)", () => {
  it("imports a pdf with outline: format/pageCount/chapters with page ranges", async () => {
    const db = createDb(":memory:");
    const bytes = await makeTextPdf({ outline: true, title: "Fixture Book", author: "Tester" });
    const book = await importBook(db, { bytes });
    expect(book.format).toBe("pdf");
    expect(book.title).toBe("Fixture Book");
    expect(book.pageCount).toBe(3);
    expect(book.hasTextLayer).toBe(true);
    expect(book.cover).not.toBeNull(); // 首页缩略图

    const chs = db.select().from(chapters).where(eq(chapters.bookId, book.id)).all();
    expect(chs).toHaveLength(2);
    expect(chs[0]).toMatchObject({ href: "pdf-ch:0", startPage: 1, endPage: 2 });
    expect(chs[1]).toMatchObject({ href: "pdf-ch:1", startPage: 3, endPage: 3 });
  });

  it("falls back to single chapter titled by book title when no outline", async () => {
    const db = createDb(":memory:");
    const bytes = await makeTextPdf({ outline: false, title: "Untitled Things" });
    const book = await importBook(db, { bytes });
    const chs = db.select().from(chapters).where(eq(chapters.bookId, book.id)).all();
    expect(chs).toHaveLength(1);
    expect(chs[0]).toMatchObject({
      href: "pdf-ch:0",
      title: "Untitled Things",
      startPage: 1,
      endPage: 3,
    });
  });

  it("detects scanned pdf and stores hasTextLayer=false", async () => {
    const db = createDb(":memory:");
    const book = await importBook(db, { bytes: await makeScannedPdf() });
    expect(book.hasTextLayer).toBe(false);
  });

  it("is idempotent for the same pdf bytes", async () => {
    const db = createDb(":memory:");
    const bytes = await makeTextPdf({ outline: false });
    const a = await importBook(db, { bytes });
    const b = await importBook(db, { bytes });
    expect(b.id).toBe(a.id);
  });

  it("rejects unknown formats with an honest error", async () => {
    const db = createDb(":memory:");
    await expect(importBook(db, { bytes: new TextEncoder().encode("hello") })).rejects.toThrow(
      /not a supported book format/i,
    );
  });
});
```

（既有 ePub 用例的 `importBook(...)` 调用前面加 `await`——签名变 async。根 `package.json` 需把 `@marginalia/pdf-parser` 加进 dependencies：`"@marginalia/pdf-parser": "workspace:*"`——对称 epub-parser 的引用方式；如 epub-parser 实际用其他写法，照抄。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL（importBook 不识别 PDF / 不是 async）。

- [ ] **Step 3: 实现**

`src/main/library/repository.ts`：

```ts
import { parsePdf, renderPageImage } from "@marginalia/pdf-parser";

/** 魔数嗅探（不信文件后缀）：%PDF- → pdf；PK\x03\x04（zip）→ epub。 */
export function detectFormat(bytes: Uint8Array): "epub" | "pdf" {
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "epub";
  throw new Error("not a supported book format (expected ePub or PDF)");
}

export async function importBook(db: DB, input: ImportInput): Promise<BookRow> {
  return detectFormat(input.bytes) === "pdf"
    ? importPdfBook(db, input.bytes)
    : importEpubBook(db, input.bytes);
}

/** 原 importBook 主体原样改名（同步逻辑不动，包一层 Promise 由 async 签名承担）。 */
function importEpubBook(db: DB, bytes: Uint8Array): BookRow {
  /* …原 importBook 函数体逐行保留… */
}

async function importPdfBook(db: DB, bytes: Uint8Array): Promise<BookRow> {
  const parsed = await parsePdf(bytes);
  const id = createHash("sha256").update(bytes).digest("hex"); // PDF 无自然键，统一文件哈希

  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  // 封面 = 首页缩略图；渲染失败不阻塞导入（书库走兜底 tile）。
  const cover = await renderPageImage(bytes, 1, { targetWidth: 600 }).catch((err) => {
    console.warn("[library] pdf cover render failed:", err);
    return null;
  });

  return db.transaction((tx) => {
    tx.insert(books)
      .values({
        id,
        title: parsed.title ?? null,
        author: parsed.author ?? null,
        cover: cover ? Buffer.from(cover) : null,
        toc: parsed.toc,
        format: "pdf",
        pageCount: parsed.pageCount,
        hasTextLayer: parsed.hasTextLayer,
      })
      .run();

    parsed.chapterRanges.forEach((range, index) => {
      tx.insert(chapters)
        .values({
          bookId: id,
          href: `pdf-ch:${index}`,
          orderIndex: index,
          // 有 outline：toc 同序号的 label；单章退化：取书名（spec §2——避免 title:null 困惑模型）
          title: parsed.toc[index]?.label ?? parsed.title ?? null,
          startPage: range.startPage,
          endPage: range.endPage,
        })
        .run();
    });

    const row = tx.select().from(books).where(eq(books.id, id)).get();
    if (!row) throw new Error("importPdfBook: book row missing after insert");
    return row;
  });
}
```

`listBooks` 的 select 追加 `format: books.format, pageCount: books.pageCount, hasTextLayer: books.hasTextLayer`（Task 6 已要求，若彼时未做在此补齐）。

`library-handlers.ts` 的 `libraryImport`：

```ts
const book = await importBook(getDb(), { bytes });
await writeBookFile(getBooksDir(), book.id, book.format, bytes);
return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
```

（错误文案 `Cannot read epub file at` 改为 `Cannot read book file at`。）

- [ ] **Step 4: 跑测试**

Run: `pnpm test src/main/library/repository.test.ts && pnpm test`
Expected: 新用例 + 全量 PASS。

- [ ] **Step 5: Commit**

```bash
git add src package.json pnpm-lock.yaml
git commit -m "feat(library): import pdf books with magic-number dispatch and cover thumbnail"
```

---

### Task 9: content-service 按格式分发 + 扫描版摘要防御

**Files:**

- Modify: `src/main/library/content.ts`
- Test: `src/main/library/content.test.ts`
- Modify: `src/main/ipc/library-handlers.ts`（generate handlers 防御）

- [ ] **Step 1: 写失败测试**

`src/main/library/content.test.ts` 追加：

```ts
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser";

describe("content (pdf)", () => {
  it("readChapterText extracts the chapter's page range with markers", async () => {
    const db = createDb(":memory:");
    const bytes = await makeTextPdf({ outline: true });
    const book = await importBook(db, { bytes });
    const chs = listChapters(db, book.id);
    const slice = await readChapterText(db, bytes, book.id, chs[0]!.id, {});
    expect(slice.text).toContain("[p.1]");
    expect(slice.text).not.toContain("[p.3]"); // 第一章只含 p1–p2
  });

  it("listChapters carries page ranges for pdf", async () => {
    const db = createDb(":memory:");
    const book = await importBook(db, { bytes: await makeTextPdf({ outline: true }) });
    const chs = listChapters(db, book.id);
    expect(chs[0]).toMatchObject({ startPage: 1, endPage: 2 });
  });

  it("readBookText concatenates all pages for pdf", async () => {
    const db = createDb(":memory:");
    const bytes = await makeTextPdf({ outline: false });
    const book = await importBook(db, { bytes });
    const r = await readBookText(db, bytes, book.id, { maxChars: 100_000 });
    expect(r.text).toContain("[p.3]");
    expect(r.truncated).toBe(false);
  });

  it("assertTextLayer throws an honest error for scanned pdf", async () => {
    const db = createDb(":memory:");
    const book = await importBook(db, { bytes: await makeScannedPdf() });
    expect(() => assertTextLayer(db, book.id)).toThrow(/text layer/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/main/library/content.test.ts`
Expected: FAIL（readChapterText 是同步的且不识别 PDF；assertTextLayer 不存在）。

- [ ] **Step 3: 实现分发**

`src/main/library/content.ts`：

```ts
import { extractPdfText } from "@marginalia/pdf-parser";
import { getBook } from "@main/library/repository";
import i18n from "@main/i18n"; // 若该模块导出方式不同，按 src/main/i18n.ts 实际导出调整

export async function readChapterText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
  opts: ReadOptions,
): Promise<ChapterTextSlice> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`content: book ${bookId} not found`);
  const ch = db
    .select({ href: chapters.href, startPage: chapters.startPage, endPage: chapters.endPage })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  if (book.format === "pdf") {
    return extractPdfText(bytes, {
      startPage: ch.startPage ?? 1,
      endPage: ch.endPage ?? book.pageCount ?? 1,
      offset: opts.offset,
      maxChars: opts.maxChars,
    });
  }
  return extractChapterText(bytes, ch.href, opts);
}

export async function readBookText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  opts: { maxChars: number },
): Promise<{ text: string; truncated: boolean }> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`content: book ${bookId} not found`);
  if (book.format === "pdf") {
    const slice = await extractPdfText(bytes, {
      startPage: 1,
      endPage: book.pageCount ?? 1,
      maxChars: opts.maxChars,
    });
    return { text: slice.text, truncated: slice.hasMore };
  }
  /* …原 epub 路径原样保留… */
}

/** 扫描版门控（spec §8 主进程防御层）：无文本层的书绝不静默生成空摘要。 */
export function assertTextLayer(db: DB, bookId: string): void {
  const book = getBook(db, bookId);
  if (book && !book.hasTextLayer) {
    throw new Error(i18n.t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本生成摘要"));
  }
}
```

注意：`readChapterText`/`readBookText` 变 async——调用方 `library-handlers.ts`（`contentChapterText` 已 async，加 `await`）与 `src/main/ai/tools.ts`、`src/main/ai/summary.ts` 的调用处补 `await`（typecheck 驱动；这些函数本身已是 async 上下文）。i18n 键新增后跑 `pnpm i18n:extract` 并在 `src/shared/i18n/locales/en.ts` 补 `"errors.noTextLayer": "This scanned PDF has no text layer, so no text can be extracted for summaries"`（主进程 i18n 若是独立资源文件，按 `src/main/i18n.ts` 实际模式放置）。

`library-handlers.ts` 两个 generate handler 的 `assertSummaryModelReady(...)` 之后各加一行：

```ts
assertTextLayer(db, input.bookId);
```

`listChapters`：Task 6 已补 `startPage`/`endPage` 输出；本任务测试覆盖其 PDF 行为。

- [ ] **Step 4: 跑测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(content): format-dispatched text extraction and scanned-pdf summary guard"
```

---

### Task 10: 渲染层 pdf-book 适配层 + locator 工具

**Files:**

- Create: `src/renderer/reader/pdf-book.ts`
- Create: `src/renderer/reader/pdf-locator.ts`
- Test: `src/renderer/reader/pdf-locator.test.ts`

- [ ] **Step 1: pdf locator 纯函数 + 测试（TDD）**

`src/renderer/reader/pdf-locator.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makePdfLocator, parsePdfLocator } from "./pdf-locator";

describe("pdf locator", () => {
  it("round-trips page + scrollRatio", () => {
    const s = makePdfLocator({ page: 12, scrollRatio: 0.35 });
    expect(s.startsWith("pdf:")).toBe(true);
    expect(parsePdfLocator(s)).toEqual({ page: 12, scrollRatio: 0.35 });
  });

  it("returns null for CFI strings and garbage", () => {
    expect(parsePdfLocator("epubcfi(/6/4!/4/2)")).toBeNull();
    expect(parsePdfLocator("pdf:not-json")).toBeNull();
    expect(parsePdfLocator('pdf:{"page":0}')).toBeNull(); // page 必须 >= 1
  });
});
```

`src/renderer/reader/pdf-locator.ts`：

```ts
/** PDF 进度 locator（spec §4）：`pdf:` 前缀 + JSON。存储层黑盒，仅 PDF reader 解释。 */
export interface PdfProgressLocator {
  page: number; // 1-based
  scrollRatio: number; // 页内滚动比例 [0,1)
}

export function makePdfLocator(loc: PdfProgressLocator): string {
  return `pdf:${JSON.stringify({ page: loc.page, scrollRatio: loc.scrollRatio })}`;
}

export function parsePdfLocator(s: string): PdfProgressLocator | null {
  if (!s.startsWith("pdf:")) return null;
  try {
    const v: unknown = JSON.parse(s.slice(4));
    if (
      typeof v === "object" &&
      v !== null &&
      typeof (v as { page?: unknown }).page === "number" &&
      (v as { page: number }).page >= 1
    ) {
      const ratio = (v as { scrollRatio?: unknown }).scrollRatio;
      return {
        page: (v as { page: number }).page,
        scrollRatio: typeof ratio === "number" ? ratio : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}
```

Run: `pnpm test src/renderer/reader/pdf-locator.test.ts`
Expected: PASS。

- [ ] **Step 2: pdf-book 适配层**

`src/renderer/reader/pdf-book.ts`：

```ts
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// vite worker 入口：打包为独立 worker chunk，经 workerPort 接给 pdfjs
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker";

if (!pdfjsLib.GlobalWorkerOptions.workerPort) {
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
}

export interface PdfBook {
  pageCount: number;
  /** 第 1 页 scale=1 尺寸（v1 假设全书同尺寸，足够覆盖书籍/技术文档主流场景）。 */
  baseSize: { width: number; height: number };
  /**
   * 渲染第 index（0-based）页到 canvas：cssWidth 为目标 CSS 宽度，内部按
   * devicePixelRatio 放大物理像素。返回 cancel 句柄（滚走/卸载时调用）。
   */
  renderPage: (
    index: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
  ) => { done: Promise<void>; cancel: () => void };
  destroy: () => void;
}

export async function createPdfBook(bytes: Uint8Array): Promise<PdfBook> {
  // pdfjs 会 transfer 传入 buffer——传副本，避免 react-query 缓存的 bytes 被 neuter。
  const doc: PDFDocumentProxy = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  }).promise;
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const baseSize = { width: base.width, height: base.height };
  first.cleanup();

  return {
    pageCount: doc.numPages,
    baseSize,

    renderPage: (index, canvas, cssWidth) => {
      let task: RenderTask | null = null;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const pageBase = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth / pageBase.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        task = page.render({ canvasContext: ctx, viewport });
        try {
          await task.promise;
        } catch (err) {
          // RenderingCancelledException = 主动取消，静默；其他错误透传
          if ((err as Error).name !== "RenderingCancelledException") throw err;
        } finally {
          page.cleanup();
        }
      })();
      return {
        done,
        cancel: () => {
          cancelled = true;
          task?.cancel();
        },
      };
    },

    destroy: () => {
      void doc.destroy();
    },
  };
}
```

- [ ] **Step 3: typecheck + Commit**

Run: `pnpm typecheck`
Expected: PASS（若 `?worker` 导入报类型错，确认 `src/renderer/vite-env.d.ts` 或等价处有 `/// <reference types="vite/client" />`；没有则补）。

```bash
git add src/renderer/reader/pdf-book.ts src/renderer/reader/pdf-locator.ts src/renderer/reader/pdf-locator.test.ts
git commit -m "feat(renderer): pdf-book adapter and pdf locator codec"
```

---

### Task 11: PdfReader 组件（虚拟化 + 缩放 + 暗色 + 进度）

**Files:**

- Create: `src/renderer/reader/PdfReader.tsx`

- [ ] **Step 1: 实现组件**

`src/renderer/reader/PdfReader.tsx`：

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import { Minus, Plus } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { useThemeStore } from "@renderer/store/theme-store";
import { qk } from "../query/keys";
import { createPdfBook, type PdfBook } from "./pdf-book";
import { makePdfLocator, parsePdfLocator } from "./pdf-locator";

interface Props {
  bookId: string;
}

const SAVE_DEBOUNCE_MS = 1000; // 对齐 EpubReader
/** 缩放档位：相对适宽的倍率。 */
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;

export function PdfReader({ bookId }: Props) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const qc = useQueryClient();
  const [book, setBook] = useState<PdfBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(1); // 1 = 适宽 100%
  const [containerW, setContainerW] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
  });

  const progress = useQuery({
    queryKey: qk.progress(bookId),
    queryFn: () => window.api.progress.get({ bookId }),
    staleTime: Infinity,
  });

  // 容器宽度（适宽缩放的输入）：ResizeObserver 跟踪。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!bytes.data) return;
    let alive = true;
    let created: PdfBook | null = null;
    setParseError(null);
    createPdfBook(bytes.data)
      .then((b) => {
        if (!alive) {
          b.destroy();
          return;
        }
        created = b;
        setBook(b);
      })
      .catch((e: Error) => alive && setParseError(e.message));
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
    };
  }, [bytes.data]);

  // 页 CSS 宽度：适宽 × 档位（容器留 48px 内边距）。
  const pageW = useMemo(() => {
    if (!book || containerW === 0) return 0;
    return Math.max(200, (containerW - 48) * ZOOM_STEPS[zoomIdx]!);
  }, [book, containerW, zoomIdx]);

  const initial = useMemo(() => {
    const loc = progress.data?.locator ? parsePdfLocator(progress.data.locator) : null;
    return loc ? { index: loc.page - 1, offsetRatio: loc.scrollRatio } : null;
  }, [progress.data]);

  const saveAt = (page: number, scrollRatio: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const locator = makePdfLocator({ page, scrollRatio });
      void window.api.progress.save({ bookId, locator });
      qc.setQueryData(qk.progress(bookId), { locator });
    }, SAVE_DEBOUNCE_MS);
  };

  if (bytes.isError) {
    return <p className="p-6 text-sm text-destructive">{(bytes.error as Error).message}</p>;
  }
  if (parseError) {
    return (
      <p className="p-6 text-sm text-destructive">
        {t("reader.pdfParseError", "PDF 解析失败：{{error}}", { error: parseError })}
      </p>
    );
  }
  if (!book || progress.isPending || pageW === 0) {
    return (
      <div ref={containerRef} className="h-full">
        <p className="p-6 text-sm text-muted-foreground">{t("reader.loading", "加载中…")}</p>
      </div>
    );
  }

  const pageH = pageW * (book.baseSize.height / book.baseSize.width);

  return (
    <div ref={containerRef} className="relative h-full">
      <Virtuoso
        className="no-scrollbar h-full"
        totalCount={book.pageCount}
        defaultItemHeight={pageH + 16}
        increaseViewportBy={{ top: pageH, bottom: pageH }}
        initialTopMostItemIndex={
          initial ? { index: initial.index, align: "start" } : { index: 0, align: "start" }
        }
        rangeChanged={(range) => saveAt(range.startIndex + 1, 0)}
        itemContent={(index) => (
          <PdfPage
            key={`${index}-${pageW}`}
            book={book}
            index={index}
            cssWidth={pageW}
            cssHeight={pageH}
            invert={resolvedTheme === "dark"}
          />
        )}
      />
      <div className="absolute right-4 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-background/90 px-1.5 py-1 shadow-sm backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("reader.zoomOut", "缩小")}
          disabled={zoomIdx === 0}
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
        >
          <Minus />
        </Button>
        <span className="min-w-12 text-center font-sans text-xs text-muted-foreground">
          {Math.round(ZOOM_STEPS[zoomIdx]! * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("reader.zoomIn", "放大")}
          disabled={zoomIdx === ZOOM_STEPS.length - 1}
          onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

/** 单页：挂载即渲染（Virtuoso 只挂可视项），卸载/重渲取消未完成任务。 */
function PdfPage(props: {
  book: PdfBook;
  index: number;
  cssWidth: number;
  cssHeight: number;
  invert: boolean;
}) {
  const { book, index, cssWidth, cssHeight, invert } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const task = book.renderPage(index, canvas, cssWidth);
    void task.done;
    return () => task.cancel();
  }, [book, index, cssWidth]);

  return (
    <div className="flex justify-center py-2">
      <canvas
        ref={canvasRef}
        className={invert ? "shadow-sm [filter:invert(1)_hue-rotate(180deg)]" : "shadow-sm"}
        // 运行时计算的目标尺寸（规范允许内联承载运行时值）
        style={{ width: cssWidth, height: cssHeight }}
      />
    </div>
  );
}
```

实现注记：

- `initialTopMostItemIndex` 用页级恢复（`align: "start"`）；`scrollRatio` v1 保存为 0、恢复时忽略页内比例——locator 格式带字段但精度后续打磨（向后兼容：parse 容忍任意 ratio）。
- 缩放换档通过 `key={index}-${pageW}` 强制重建页组件触发重渲。
- 暗色按主题反色；spec 的「按书可关」推后续打磨（见计划尾 deferred 清单）。

- [ ] **Step 2: i18n 抽取**

Run: `pnpm i18n:extract`
然后在 `src/shared/i18n/locales/en.ts` 为新键补英文：`"reader.pdfParseError": "Failed to parse PDF: {{error}}"`、`"reader.loading": "Loading…"`（若已存在则跳过）、`"reader.zoomIn": "Zoom in"`、`"reader.zoomOut": "Zoom out"`。

- [ ] **Step 3: typecheck + Commit**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（渲染层启用 React Compiler——不要手写 useCallback/useMemo 补「优化」）。

```bash
git add src/renderer src/shared/i18n
git commit -m "feat(renderer): PdfReader with virtualized canvas pages, zoom steps and progress"
```

---

### Task 12: ReaderView 格式分发 + ReaderPrefs/摘要门控 + 书库 PDF 入口

**Files:**

- Modify: `src/renderer/reader/ReaderView.tsx`
- Modify: `src/renderer/library/epub-drop.ts`（+ `epub-drop.test.ts` 如有）
- Modify: `src/renderer/library/LibraryView.tsx`

- [ ] **Step 1: ReaderView 分发**

`src/renderer/reader/ReaderView.tsx`：

- import 追加 `import { PdfReader } from "@renderer/reader/PdfReader";`
- 原 `<EpubReader bookId={bookId} chapters={chapters.data ?? []} />` 处改为：

```tsx
{
  book.data?.format === "pdf" ? (
    <PdfReader bookId={bookId} />
  ) : (
    <EpubReader bookId={bookId} chapters={chapters.data ?? []} />
  );
}
```

（`book` query 已存在于该组件。`book.data` 未就绪时走 else 分支渲染 EpubReader 会闪——在外层包 `{book.isPending ? null : (…分发…)}` 防误挂。）

- ReaderPrefs 门控：顶栏 `<ReaderPrefs />` 渲染处改 `{book.data?.format !== "pdf" && <ReaderPrefs />}`（字体/行距/栏宽对 PDF 无意义）。
- 章节摘要 pill 门控（扫描版 UI 层）：顶栏 `<SummaryPill />` 渲染处改 `{book.data?.hasTextLayer !== false && <SummaryPill />}`。
- 自动摘要 effect 门控：`useEffect` 条件追加 `|| book.data?.hasTextLayer === false` 提前 return（避免开章自动触发对扫描版反复打防御层）。

- [ ] **Step 2: 拖拽/选择入口接受 PDF**

`src/renderer/library/epub-drop.ts`：`pickEpubFiles` 改为按后缀分组 epub+pdf——

```ts
const BOOK_EXTENSIONS = [".epub", ".pdf"];

export function pickBookFiles<T extends { name: string }>(files: readonly T[]): SortedDrop<T> {
  const books: T[] = [];
  const ignored: T[] = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (BOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))) books.push(f);
    else ignored.push(f);
  }
  return { books, ignored };
}
```

（`SortedDrop` 字段 `epubs` → `books`；旧函数名删除，typecheck 驱动改 `LibraryView.tsx` 的 `onFiles` 与 `use-epub-drop` 等引用、相关测试断言同步。）

`LibraryView.tsx` 文案更新（键不变，改默认值 + en）：

- `t("library.import", "导入书籍")`；en：`"Import books"`
- `t("library.empty", "书库为空，点右上角「导入书籍」或把 .epub / .pdf 拖进窗口开始。")`；en 同步
- `t("library.ignored", "已忽略 {{count}} 个不支持的文件：{{names}}")`；en：`"Ignored {{count}} unsupported file(s): {{names}}"`

Run: `pnpm i18n:extract`，en.ts 同步上述键。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿。

```bash
git add src
git commit -m "feat(renderer): dispatch reader by format, gate prefs/summary, accept pdf drops"
```

---

### Task 13: 构建与打包配置（vite external + forge 白名单）

**Files:**

- Modify: `vite.main.config.ts`
- Modify: `forge.config.ts`

- [ ] **Step 1: 主进程 external**

`vite.main.config.ts` 的 `build.rollupOptions.external` 改为：

```ts
      external: ["better-sqlite3", /^pdfjs-dist/, "@napi-rs/canvas"],
```

（pdfjs legacy 与 @napi-rs/canvas 运行时从 node_modules 解析，不内联进 .vite bundle——pdfjs 内部对 @napi-rs/canvas 的条件 require 在 bundle 后会失效，external 是稳妥路径。）

- [ ] **Step 2: forge 打包白名单**

`forge.config.ts` 的 `KEEP_NODE_MODULES` 改为：

```ts
const KEEP_NODE_MODULES = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  // pdf 支持：主进程 external 的 pdfjs 与 NAPI canvas（平台二进制包名是
  // @napi-rs/canvas-<platform>-<arch>，与主包平级，需逐个列出）
  "pdfjs-dist",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-darwin-x64",
];
```

- [ ] **Step 3: dev 启动验证**

Run: `pnpm start`（确认主进程不再因 external 缺失报错、渲染层 worker chunk 正常加载；窗口出现即 Ctrl+C 退出）
Expected: 启动无 `cannot find module` 类错误。

- [ ] **Step 4: Commit**

```bash
git add vite.main.config.ts forge.config.ts
git commit -m "build: externalize pdfjs/@napi-rs-canvas and keep them in packaged app"
```

---

### Task 14: 全量回归 + CDP 真启动冒烟 + 打包冒烟

**Files:** 无新文件（验证任务）

- [ ] **Step 1: 全量回归**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全绿。

- [ ] **Step 2: 导出冒烟用 PDF fixture**

```bash
node --input-type=module -e "
import { makeTextPdf, makeScannedPdf } from './packages/pdf-parser/src/fixture.ts';
" 2>/dev/null || true
```

注：源码 TS 无法直接被 node 执行——改用 vitest 跑一次性脚本或手动准备：用任意真实 PDF（有书签的技术文档最佳）放 `/tmp/smoke.pdf`，另备一个扫描版 `/tmp/smoke-scanned.pdf`（没有就跳过扫描版冒烟项，记录到 PR 描述）。

- [ ] **Step 3: CDP 真启动冒烟**（dev 同样吃 `--user-data-dir`；恰好一个 `--` 透传）

```bash
pnpm start -- --user-data-dir=/tmp/marginalia-pdf-smoke --remote-debugging-port=9222
```

冒烟清单（经 CDP 或人工）：

1. 导入 `/tmp/smoke.pdf` → 书库出现卡片**且有封面缩略图**
2. 打开 → canvas 页渲染、滚动流畅、页间距正常
3. 缩放 +/− 档位 → 页宽变化、重渲清晰（dpr 无糊）
4. 暗色模式 → 页面反色
5. TOC（侧栏章节列表）显示 outline 章节、点击跳页（**注**：跳页依赖 ChapterList 的跳章逻辑——若其实现耦合 epub `indexOfHref`，本阶段记录现象即可，跳页接线属 P2 验收）
6. 滚到中部 → 退出 app → 重启同参数 → 恢复到同页
7. 扫描版导入 → 能看、顶栏无摘要 pill
8. ePub 回归：开一本既有 ePub，阅读/选区/高亮/进度一切如常
9. 设置页 → PDF 打开时顶栏无 ReaderPrefs 按钮；ePub 时有

- [ ] **Step 4: 打包冒烟**（native dep 进产物的关键验证）

```bash
pnpm package
open out/marginalia-darwin-*/marginalia.app --args --user-data-dir=/tmp/marginalia-pdf-pack-smoke
```

验证：app 启动、导入 PDF 成功（= @napi-rs/canvas 在产物内可加载）、sqlite3 表齐全。

- [ ] **Step 5: 修正 ROADMAP + Commit**

`docs/superpowers/ROADMAP.md`：「里程碑 / 工作单元状态」渲染层表后追加 PDF 轨表（PDF-P1 ✅ / PDF-P2 🔴 / PDF-P3 🔴），backlog 补「PDF 文档句柄缓存」「Ctrl+滚轮平滑缩放」「PDF 暗色按书关闭」「PDF scrollRatio 页内精确恢复」「PDF TOC 跳页接线（P2）」。

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): record pdf-p1 progress and deferred items"
```

---

## 计划级 Deferred（P1 明确不做，留 P2/P3 或打磨）

- textLayer 选区 / 问 AI / readPage 工具 / system prompt 注入 → **P2**
- 标注（locatorRange 持久化 + 矩形 overlay）→ **P3**
- TOC 跳页接线（ChapterList → PdfReader scrollToIndex）→ **P2**（P1 仅展示）
- scrollRatio 页内精确恢复、暗色按书关闭、文档句柄缓存、Ctrl+滚轮缩放 → 打磨期
- spec §5.3 `BookSummaryDto` 的 `format` 已落；`library:import` 错误文案 i18n 化沿既有模式

## Self-Review 结论（已自查）

- spec §4/§5.1/§5.2/§5.3/§6（P1 范围内条目）均有对应任务；§7/§8 的 UI 门控线落 Task 9/12，工具分发属 P2。
- 类型一致性：`storedBookPath/readBookFile(format)` 贯穿 Task 7–9；`ChapterRefDto.startPage/endPage` 在 Task 6 定义、Task 9 测试；`qk.bookBytes` 在 Task 6 改名、Task 11 消费。
- 无 TBD/占位符；i18n 键随任务给出 zh/en 双值。
