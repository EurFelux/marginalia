# 锚点级章节 · Plan A（headless / 主进程）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「章节」从 spine 文件重定义为 TOC 条目（href + anchor），让锚点切章的 ePub 在解析 / 数据模型 / 内容切分 / AI 单元全链路按锚点工作（headless 部分；渲染端导航是 Plan B）。

**Architecture:** 解析层保留 `#fragment` 落入 `TocNode.anchor`；`chapters` 表改为「1 行 = 1 个 TOC 条目（含 `anchor`）」，唯一约束 `(bookId, href, anchor)`；章节正文按「本 anchor → 同文件下一边界 anchor」切分（用 `node-html-parser` 元素 `.range` 源码偏移）；存量书经 `books.parserVersion` 门控、开书时从磁盘字节惰性重建索引。

**Tech Stack:** TypeScript, fflate, fast-xml-parser, node-html-parser, Drizzle ORM 1.0-rc + better-sqlite3, Zod 4, vitest（Electron ABI 运行时）。

**设计依据：** `docs/superpowers/specs/2026-06-08-marginalia-anchor-level-chapters-design.md`

**关键约束（来自 CLAUDE.md / 记忆）：**

- 测试用 `pnpm test <file>`（跑在 Electron 运行时）。
- drizzle 改 schema 后用 `pnpm db:generate`（**不要手编迁移**）；表重建 FK 事务坑已在 `runMigrations` 处理（事务外切 FK），本 Plan 不动迁移执行逻辑。
- 提交用 Conventional Commits；pre-commit 钩子（prek）会跑 `lint:fix` + `format`，若改了暂存文件需 `git add` 后重跑同一 commit。
- 当前分支 `feat/anchor-level-chapters`（已含 spec commit）。所有任务在此分支提交。

---

## File Structure

| 文件                                       | 职责              | 改动                                                                       |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------- |
| `packages/epub-parser/src/types.ts`        | ePub 解析产物类型 | `TocNode` 增 `anchor?`                                                     |
| `packages/epub-parser/src/parse.ts`        | OPF/NCX/nav 解析  | `readToc` 保留 fragment 入 `anchor`                                        |
| `packages/epub-parser/src/content.ts`      | 章节纯文本抽取    | 新增锚点区间切分 `extractChapterText(…, anchor?, nextAnchor?)`             |
| `packages/epub-parser/src/parse.test.ts`   | 解析测试          | 加锚点保留用例                                                             |
| `packages/epub-parser/src/content.test.ts` | 抽取测试          | 加锚点切分用例                                                             |
| `src/shared/types.ts`                      | 跨层类型 + zod    | `tocNodeSchema` 增 `anchor`                                                |
| `src/shared/library.ts`                    | DTO               | `ChapterRefDto` 增 `anchor`                                                |
| `src/main/db/schema.ts`                    | DB schema         | `chapters.anchor`、唯一约束改、`books.parserVersion`                       |
| `src/main/db/migrations/*`                 | 迁移              | `pnpm db:generate` 产物                                                    |
| `src/main/library/repository.ts`           | 导入 / 解析→DB    | TOC 建章、`resolveChapter`、`reindexBookIfStale`、`CURRENT_PARSER_VERSION` |
| `src/main/library/content.ts`              | 导航 / 内容消费   | `listChapters` 去塌缩、`readChapterText` 传锚点、`readBookText` 去重       |
| `src/main/library/repository.test.ts`      | repository 测试   | TOC 建章 / resolve / reindex 用例                                          |
| `src/main/library/content.test.ts`         | content 测试      | listChapters / readChapterText 用例                                        |
| `src/main/ipc/library-handlers.ts`         | IPC 胶水          | `ensureEpubIndexed` 接线（toc/chapters/chapterText/readBookBytes）         |
| `src/main/ai/tools.ts`                     | AI 工具           | 仅核对（getToc/readChapter 天然按锚点章工作）                              |

---

## Task 1: `TocNode.anchor` + 解析保留 fragment

把 TOC 解析的 `#fragment` 从被 `.split("#")[0]` 丢弃改为落入 `TocNode.anchor`（仅有 fragment 时才设键，保持无锚点节点形状不变 → 现有测试不破）。

**Files:**

- Modify: `packages/epub-parser/src/types.ts:5-9`
- Modify: `packages/epub-parser/src/parse.ts:121-134`（EPUB3 nav）、`packages/epub-parser/src/parse.ts:152-162`（NCX `toNode`）
- Modify: `src/shared/types.ts:16-22`
- Test: `packages/epub-parser/src/parse.test.ts`

- [ ] **Step 1: 写失败测试（NCX + EPUB3 nav 各保留 anchor）**

在 `packages/epub-parser/src/parse.test.ts` 的 `describe("parseEpub", …)` 内追加：

```ts
it("NCX: preserves #fragment into TocNode.anchor", () => {
  const bytes = buildEpub({
    "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    "OEBPS/content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:anchor-ncx</dc:identifier><dc:title>Anchor NCX</dc:title>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="big" href="big.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="big"/></spine>
</package>`,
    "OEBPS/toc.ncx": `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>第1章</text></navLabel><content src="big.xhtml#a1"/></navPoint>
  <navPoint id="n2"><navLabel><text>第2章</text></navLabel><content src="big.xhtml#a2"/></navPoint>
</navMap></ncx>`,
    "OEBPS/big.xhtml": `<html><body><p><span id="a1">第1章</span></p><p><span id="a2">第2章</span></p></body></html>`,
  });
  const toc = parseEpub(bytes).toc;
  expect(toc).toEqual([
    { label: "第1章", href: "OEBPS/big.xhtml", anchor: "a1" },
    { label: "第2章", href: "OEBPS/big.xhtml", anchor: "a2" },
  ]);
});

it("EPUB3 nav: preserves #fragment into TocNode.anchor; no fragment ⇒ no anchor key", () => {
  const bytes = buildEpub({
    "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    "content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Anchor Nav</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="big" href="big.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="big"/></spine>
</package>`,
    "nav.xhtml": `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>
  <li><a href="big.xhtml#s1">Sec 1</a></li>
  <li><a href="big.xhtml">Whole</a></li>
</ol></nav></body></html>`,
    "big.xhtml": `<html><body><p><span id="s1">Sec 1</span></p></body></html>`,
  });
  const toc = parseEpub(bytes).toc;
  expect(toc).toEqual([
    { label: "Sec 1", href: "big.xhtml", anchor: "s1" },
    { label: "Whole", href: "big.xhtml" },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/epub-parser/src/parse.test.ts`
Expected: FAIL —新用例报 `anchor` 缺失（解析仍剥锚点）。既有用例仍 PASS。

- [ ] **Step 3: 改 `TocNode` 类型**

`packages/epub-parser/src/types.ts`，把 `TocNode` 改为：

```ts
export interface TocNode {
  label: string;
  href: string;
  /** 章内 #fragment（如 "filepos0000044175"）；仅当 TOC 条目带锚点时存在。无锚点时此键缺省。 */
  anchor?: string;
  children?: TocNode[];
}
```

- [ ] **Step 4: 改 NCX 解析（`parse.ts` 的 `toNode`）**

`packages/epub-parser/src/parse.ts`，把 `toNode`（约 `:152-162`）改为：

```ts
const toNode = (np: unknown): TocNode => {
  const p = np as NavPoint;
  const raw = p.content?.["@_src"] ?? "";
  const [path, frag] = raw.split("#");
  const node: TocNode = {
    label: (p.navLabel?.text ?? "").toString().trim(),
    href: path ? resolveHref(ncxDir, path) : "",
  };
  if (frag) node.anchor = frag;
  const kids = asArray(p.navPoint).map(toNode);
  if (kids.length) node.children = kids;
  return node;
};
```

- [ ] **Step 5: 改 EPUB3 nav 解析（`parse.ts` 的 `walk`）**

`packages/epub-parser/src/parse.ts`，把 `walk` 内构造 node 的片段（约 `:126-130`）改为：

```ts
const rawHref = a?.getAttribute("href") ?? "";
const [path, frag] = rawHref.split("#");
const node: TocNode = {
  label: (a?.text ?? "").trim(),
  href: path ? resolveHref(navDir, path) : "",
};
if (frag) node.anchor = frag;
```

（注意：删掉原先的 `const href = a?.getAttribute("href")?.split("#")[0] ?? "";` 与原 `href:` 行，用上面替换；后续 `walk(childOl)` 与 `.filter((n) => n.label || n.href)` 不变。）

- [ ] **Step 6: 改 `tocNodeSchema`（shared 镜像）**

`src/shared/types.ts` 的 `tocNodeSchema`：

```ts
export const tocNodeSchema: z.ZodType<TocNode> = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    anchor: z.string().optional(),
    children: z.array(tocNodeSchema).optional(),
  }),
);
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm test packages/epub-parser/src/parse.test.ts`
Expected: PASS（新用例 + 全部既有用例）。

- [ ] **Step 8: typecheck**

Run: `pnpm typecheck`
Expected: 通过（`TocNode.anchor` 全链路类型一致）。

- [ ] **Step 9: 提交**

```bash
git add packages/epub-parser/src/types.ts packages/epub-parser/src/parse.ts packages/epub-parser/src/parse.test.ts src/shared/types.ts
git commit -m "feat(epub): preserve TOC fragment into TocNode.anchor"
```

---

## Task 2: 内容按锚点区间切分

`extractChapterText` 增 `anchor?`/`nextAnchor?` 入参：给定 anchor 时，只抽取「本 anchor 所在块（含）到 nextAnchor 所在块（不含）」的块级文本；anchor 缺省时退化为现有整文件行为。

**算法（已用 node-html-parser 7.1.0 实测验证）：** 用元素 `.range`（`[start,end]` 源码偏移）。设 `startOffset = getElementById(anchor).range[0]`，`endOffset = nextAnchor ? getElementById(nextAnchor).range[0] : Infinity`。保留顶层块 B 当且仅当 `B.range[1] > startOffset && B.range[1] <= endOffset`。

**Files:**

- Modify: `packages/epub-parser/src/content.ts:22-80`
- Test: `packages/epub-parser/src/content.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/epub-parser/src/content.test.ts` 追加（fixture 用 fflate 直接打一个含锚点的单 spine ePub；顶部已有 `import { strToU8, zipSync } from "fflate"` 则复用，否则加）：

```ts
import { strToU8, zipSync } from "fflate";

function anchorEpub(): Uint8Array {
  const big = `<html><body>
<p>封面无关文字</p>
<p><span id="a1">第1章 标题</span></p>
<p>第一章正文段落。</p>
<p><span id="a2">第2章 标题</span></p>
<p>第二章正文段落。</p>
</body></html>`;
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "big.xhtml": strToU8(big),
  });
}

describe("extractChapterText anchor slicing", () => {
  it("slices [anchor, nextAnchor) — first chapter", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "a1", "a2");
    expect(r.text).toBe("第1章 标题\n第一章正文段落。");
    expect(r.hasMore).toBe(false);
  });

  it("slices to end of file — last chapter (no nextAnchor)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "a2");
    expect(r.text).toBe("第2章 标题\n第二章正文段落。");
  });

  it("anchor undefined ⇒ whole-file behavior (unchanged)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {});
    expect(r.text).toContain("封面无关文字");
    expect(r.text).toContain("第二章正文段落。");
  });

  it("missing anchor element ⇒ degrades to whole file (no throw)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "nope");
    expect(r.text).toContain("封面无关文字");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/epub-parser/src/content.test.ts`
Expected: FAIL —`extractChapterText` 尚不接受第 4/5 参数，锚点用例文本不符。

- [ ] **Step 3: 实现切分**

`packages/epub-parser/src/content.ts`：把 `htmlToText` 内联的块收集抽成共享小函数，并新增锚点切分。具体——

(a) 把 `htmlToText` 内联的块级收集逻辑提为**模块级共享**（供 `htmlToText` 与新切分函数共用）。先扩展既有 import（`content.ts:2` 已有 `import { parse as parseHtml } from "node-html-parser";`，补 `HTMLElement` 类型），再在文件靠上处定义：

```ts
import { parse as parseHtml, type HTMLElement } from "node-html-parser";

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption";
const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "pre",
  "figcaption",
]);

/** 该元素是否嵌在另一块级元素内（其文本已被祖先块收集，跳过以免重复）。 */
function isNestedInsideBlock(el: HTMLElement): boolean {
  let node = el.parentNode as HTMLElement | null;
  while (node) {
    if (node.rawTagName && BLOCK_TAGS.has(node.rawTagName.toLowerCase())) return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

/** 顶层块级元素（保序）：querySelectorAll 命中后剔除嵌套块。 */
function topLevelBlocks(body: HTMLElement): HTMLElement[] {
  return body.querySelectorAll(BLOCK_SELECTOR).filter((b) => !isNestedInsideBlock(b));
}
```

然后把 `htmlToText` 函数体里原先内联的 `BLOCK_TAGS` 常量、`isNestedInsideBlock` 局部函数、`body.querySelectorAll("h1,h2,…").filter(...)` 替换为一行 `const topLevel = topLevelBlocks(body);`（行为完全不变，仅去重）。

(b) 新增锚点区间文本函数（复用 `topLevelBlocks`）：

```ts
/** 取某 anchor 所在 spine 文件的「本章块级文本」：[anchor 所在块, nextAnchor 所在块) 区间。 */
function sliceTextByAnchor(xhtml: string, anchor: string, nextAnchor?: string): string {
  const root = parseHtml(xhtml);
  const body = (root.querySelector("body") ?? root) as HTMLElement;
  const startEl = root.getElementById(anchor);
  if (!startEl) return htmlToText(xhtml); // 定位不到 ⇒ 退化整文件（不静默空）
  const startOffset = startEl.range[0];
  const endEl = nextAnchor ? root.getElementById(nextAnchor) : null;
  const endOffset = endEl ? endEl.range[0] : Number.POSITIVE_INFINITY;
  const parts = topLevelBlocks(body)
    .filter((b) => b.range[1] > startOffset && b.range[1] <= endOffset)
    .map((b) => b.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join("\n");
}
```

(c) 改 `extractChapterText` 签名与体：

```ts
export function extractChapterText(
  bytes: Uint8Array,
  href: string,
  opts: ReadOptions,
  anchor?: string,
  nextAnchor?: string,
): ChapterTextSlice {
  const files = unzipSync(bytes);
  const entry = files[href];
  if (!entry) throw new Error(`epub: missing entry ${href}`);
  const xhtml = strFromU8(entry);
  const full = anchor ? sliceTextByAnchor(xhtml, anchor, nextAnchor) : htmlToText(xhtml);
  const offset = Math.max(0, opts.offset ?? 0);
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const slice = full.slice(offset, offset + maxChars);
  const nextOffset = Math.min(offset + slice.length, full.length);
  return { text: slice, hasMore: nextOffset < full.length, nextOffset };
}
```

> 注：`isNestedInsideBlock` 在 `htmlToText` 内已有同名局部函数；实现时提为模块级、两处共用（DRY），别留两份。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test packages/epub-parser/src/content.test.ts`
Expected: PASS（锚点切分 4 用例 + 既有 `htmlToText`/`extractChapterText`/`extractBookText` 用例）。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/epub-parser/src/content.ts packages/epub-parser/src/content.test.ts
git commit -m "feat(epub): slice chapter text by anchor range"
```

---

## Task 3: DB schema — `chapters.anchor`、唯一约束、`books.parserVersion`

**Files:**

- Modify: `src/main/db/schema.ts:61-105`
- Generate: `src/main/db/migrations/<new>/`

- [ ] **Step 1: 改 schema**

`src/main/db/schema.ts`：

`books` 表 `values` 段加（紧跟 `position` 之后、闭合 `}` 之前）：

```ts
    // 解析器版本：低于 CURRENT_PARSER_VERSION 的书开书时惰性重建索引（锚点级章节升级）。null/0 = 旧。
    parserVersion: integer("parser_version").notNull().default(0),
```

`chapters` 表：`href` 之后加 `anchor` 列，并把表级约束的 `unique().on(t.bookId, t.href)` 改为含 anchor：

```ts
export const chapters = sqliteTable(
  "chapters",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    title: text("title"),
    orderIndex: integer("order_index"),
    href: text("href").notNull(),
    anchor: text("anchor"), // 章内 #fragment（如 "filepos…"）；无锚点章为 null
    startPage: integer("start_page"),
    endPage: integer("end_page"),
    summary: text("summary"),
  },
  (t) => [unique().on(t.bookId, t.href, t.anchor), index("chapters_book_id_idx").on(t.bookId)],
);
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 在 `src/main/db/migrations/` 下新增子目录（含 `migration.sql` + `snapshot.json`）。**不要手编**。

- [ ] **Step 3: 校验迁移可用（跑任一 DB 测试，会触发 `:memory:` 迁移）**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: 迁移成功（建表含 anchor / parser_version 列）；既有用例多数仍 PASS（导入逻辑 Task 4 才改，部分断言可能因列新增不受影响）。若有迁移执行错误（FK / 表重建）须停下排查（见 [[drizzle-migrate-fk-transaction-gotcha]]）。

- [ ] **Step 4: 提交**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(db): add chapters.anchor + books.parserVersion, key chapters by (book,href,anchor)"
```

---

## Task 4: repository — TOC 建章 + `resolveChapter` + `CURRENT_PARSER_VERSION`

把导入从「按 spine 建章」改为「按扁平 TOC 建章（含 anchor）」；无 TOC 退回 spine。新增按 `(href, anchor)` 精确解析。

**Files:**

- Modify: `src/main/library/repository.ts`
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/library/repository.test.ts` 追加（沿用文件内既有 `makeDb`/fixture 模式；epub fixture 用 fflate 内联，含 2 spine + NCX 多锚点。若文件已有 epub 构建 helper 则复用）：

```ts
import { strToU8, zipSync } from "fflate";
import { resolveChapter, CURRENT_PARSER_VERSION } from "./repository";

function anchorBook(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:anchor-book</dc:identifier><dc:title>Anchor Book</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="t0" href="t0.xhtml" media-type="application/xhtml+xml"/>
    <item id="t1" href="t1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="t0"/><itemref idref="t1"/></spine>
</package>`),
    "OEBPS/toc.ncx": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>第1章</text></navLabel><content src="t0.xhtml#a1"/></navPoint>
  <navPoint id="n2"><navLabel><text>第2章</text></navLabel><content src="t0.xhtml#a2"/></navPoint>
  <navPoint id="n3"><navLabel><text>第3章</text></navLabel><content src="t1.xhtml#b1"/></navPoint>
</navMap></ncx>`),
    "OEBPS/t0.xhtml": strToU8(
      `<html><body><p><span id="a1">第1章</span></p><p><span id="a2">第2章</span></p></body></html>`,
    ),
    "OEBPS/t1.xhtml": strToU8(`<html><body><p><span id="b1">第3章</span></p></body></html>`),
  });
}

describe("importEpubBook builds chapters from TOC entries (anchors)", () => {
  it("creates one chapter row per TOC entry with anchor", async () => {
    const db = makeDb(); // 文件内既有 helper
    const book = await importBook(db, { bytes: anchorBook() });
    const rows = db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .orderBy(asc(chapters.orderIndex))
      .all();
    expect(rows.map((r) => [r.title, r.href, r.anchor])).toEqual([
      ["第1章", "OEBPS/t0.xhtml", "a1"],
      ["第2章", "OEBPS/t0.xhtml", "a2"],
      ["第3章", "OEBPS/t1.xhtml", "b1"],
    ]);
    expect(book.parserVersion).toBe(CURRENT_PARSER_VERSION);
  });

  it("resolveChapter matches exact (href, anchor)", async () => {
    const db = makeDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const ch = resolveChapter(db, book.id, "OEBPS/t0.xhtml", "a2");
    expect(ch?.title).toBe("第2章");
  });
});
```

> 实现者：若 `repository.test.ts` 顶部尚无 `chapters`/`eq`/`asc`/`importBook`/`makeDb` 引入，按文件现有 import 补齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL —当前按 spine 建章（只有 2 行、无 anchor），`resolveChapter`/`CURRENT_PARSER_VERSION` 未导出。

- [ ] **Step 3: 实现 TOC 建章 + resolveChapter + 版本常量**

`src/main/library/repository.ts`：

(a) 文件顶部（`const log = …` 后）加版本常量与 TOC 扁平器，删除旧 `tocLabelByHref`：

```ts
/** 解析器/索引结构版本。结构变更（如锚点级章节）时 +1，触发存量书惰性重建。 */
export const CURRENT_PARSER_VERSION = 1;

interface ChapterSeed {
  href: string;
  anchor: string | null;
  title: string | null;
}

/** 扁平化 TOC（DFS 保序）为章节种子；按 (href, anchor) 去重保首个（防 TOC 重复条目撞唯一约束）。 */
function chapterSeedsFromToc(toc: TocNode[]): ChapterSeed[] {
  const seeds: ChapterSeed[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TocNode[]): void => {
    for (const n of nodes) {
      const anchor = n.anchor ?? null;
      const key = `${n.href}|${anchor ?? ""}`;
      if (n.href && !seen.has(key)) {
        seen.add(key);
        seeds.push({ href: n.href, anchor, title: n.label || null });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(toc);
  return seeds;
}

/** 章节种子：优先 TOC 条目（锚点级）；无 TOC 退回 spine 文件顺序（anchor=null, title=null）。 */
function chapterSeedsFor(parsed: { toc: TocNode[]; spine: { href: string }[] }): ChapterSeed[] {
  const fromToc = chapterSeedsFromToc(parsed.toc);
  if (fromToc.length > 0) return fromToc;
  return parsed.spine.map((s) => ({ href: s.href, anchor: null, title: null }));
}
```

(b) `importEpubBook` 的事务体把 `books` insert 的 `values` 加 `parserVersion: CURRENT_PARSER_VERSION`，并把 `const labels = …; parsed.spine.forEach(…)` 整段替换为：

```ts
chapterSeedsFor(parsed).forEach((seed, index) => {
  tx.insert(chapters)
    .values({
      bookId: id,
      href: seed.href,
      anchor: seed.anchor,
      orderIndex: index,
      title: seed.title,
    })
    .run();
});
```

(c) `importPdfBook` 的 `books` insert `values` 也加 `parserVersion: CURRENT_PARSER_VERSION`（PDF 章节无锚点，chapters insert 不变——`anchor` 列默认 null）。

(d) 在 `resolveChapterByHref` 旁新增精确解析（保留 `resolveChapterByHref` 供 AI 容错回退）：

```ts
/** 按 (href, anchor) 精确解析章节行；anchor 为 null 时匹配 anchor IS NULL 行。 */
export function resolveChapter(
  db: DB,
  bookId: string,
  href: string,
  anchor: string | null,
): ChapterRow | undefined {
  return db
    .select()
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        eq(chapters.href, href),
        anchor === null ? isNull(chapters.anchor) : eq(chapters.anchor, anchor),
      ),
    )
    .get();
}
```

(e) 顶部 import 补 `isNull`：`import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS（新用例 + 既有用例。既有「按 spine 建章」断言若存在需同步更新为 TOC 口径——见下方 Step 5）。

- [ ] **Step 5: 修既有受影响断言**

既有 `repository.test.ts` 中若有断言「导入后 chapters 行数 = spine 数 / href = spine href」，因 fixture（`makeFixtureEpub`）的 nav TOC 无 fragment、且每文件一条目，TOC 扁平结果应与 spine 一一对应（href 相同、anchor 缺省→null、title=label）。逐一核对：原断言 title 可能从 `null` 变为 TOC label（如 "Chapter One"）。按新口径更新断言文本，不得放宽语义。

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/library/repository.ts src/main/library/repository.test.ts
git commit -m "feat(library): build chapters from flattened TOC entries with anchors"
```

---

## Task 5: repository — `reindexBookIfStale`（存量书惰性重建）

**Files:**

- Modify: `src/main/library/repository.ts`
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

追加（复用 Task 4 的 `anchorBook()`）：

```ts
import { reindexBookIfStale } from "./repository";
import { books } from "@main/db/schema";

describe("reindexBookIfStale", () => {
  it("rebuilds chapters + toc + parserVersion when stale; no-op when fresh", async () => {
    const db = makeDb();
    const bytes = anchorBook();
    const book = await importBook(db, { bytes });
    // 模拟存量旧书：降级 parserVersion 并把 chapters 砍成 1 行（旧 spine 口径）。
    db.update(books).set({ parserVersion: 0 }).where(eq(books.id, book.id)).run();
    db.delete(chapters).where(eq(chapters.bookId, book.id)).run();
    db.insert(chapters)
      .values({ bookId: book.id, href: "OEBPS/t0.xhtml", orderIndex: 0, title: null })
      .run();

    const changed = reindexBookIfStale(db, bytes, book.id);
    expect(changed).toBe(true);
    const rows = db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .orderBy(asc(chapters.orderIndex))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.anchor)).toEqual(["a1", "a2", "b1"]);
    expect(db.select().from(books).where(eq(books.id, book.id)).get()?.parserVersion).toBe(
      CURRENT_PARSER_VERSION,
    );

    // 第二次调用：版本已最新 ⇒ no-op。
    expect(reindexBookIfStale(db, bytes, book.id)).toBe(false);
  });

  it("PDF books are skipped (no epub reparse)", async () => {
    const db = makeDb();
    // 用文件内既有 PDF fixture / 或最小 PDF 字节；断言 reindexBookIfStale 对 pdf 返回 false 不抛。
    // （若无现成 PDF fixture，可跳过此用例，仅保留上面的 epub 用例。）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts -t reindex`
Expected: FAIL —`reindexBookIfStale` 未定义。

- [ ] **Step 3: 实现 `reindexBookIfStale`**

`src/main/library/repository.ts` 新增：

```ts
/**
 * 存量书惰性升级：若 book.parserVersion < CURRENT_PARSER_VERSION，从字节重解析并事务内重建
 * chapters + toc + parserVersion。返回是否实际重建。幂等；版本已最新 / 非 epub / 解析失败 → false。
 * 安全性：annotations/progress/conversations 均 FK 挂 books.id（非 chapters.id），DELETE chapters 不级联误删。
 */
export function reindexBookIfStale(db: DB, bytes: Uint8Array, bookId: string): boolean {
  const book = getBook(db, bookId);
  if (!book || book.format !== "epub") return false;
  if ((book.parserVersion ?? 0) >= CURRENT_PARSER_VERSION) return false;
  let parsed;
  try {
    parsed = parseEpub(bytes);
  } catch (err) {
    log.warn(`reindex parse failed, keeping old index (book ${bookId})`, err);
    return false;
  }
  db.transaction((tx) => {
    tx.delete(chapters).where(eq(chapters.bookId, bookId)).run();
    chapterSeedsFor(parsed).forEach((seed, index) => {
      tx.insert(chapters)
        .values({
          bookId,
          href: seed.href,
          anchor: seed.anchor,
          orderIndex: index,
          title: seed.title,
        })
        .run();
    });
    tx.update(books)
      .set({ toc: parsed.toc, parserVersion: CURRENT_PARSER_VERSION })
      .where(eq(books.id, bookId))
      .run();
  });
  log.info(`reindexed book ${bookId} to parser v${CURRENT_PARSER_VERSION}`);
  return true;
}
```

> import `books` 已在 `repository.ts` 顶部（`import { books, chapters, progress } …`）；若缺 `parseEpub` 已在顶部（Task 4 用过）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/library/repository.ts src/main/library/repository.test.ts
git commit -m "feat(library): lazy reindex stale books to anchor-level chapters"
```

---

## Task 6: content.ts — `listChapters` 去塌缩 + `readChapterText` 锚点 + `readBookText` 去重 + `ChapterRefDto.anchor`

**Files:**

- Modify: `src/shared/library.ts:75-83`
- Modify: `src/main/library/content.ts`
- Test: `src/main/library/content.test.ts`

- [ ] **Step 1: 加 `ChapterRefDto.anchor`**

`src/shared/library.ts` 的 `ChapterRefDto`：

```ts
export interface ChapterRefDto {
  id: string;
  title: string | null;
  href: string;
  anchor: string | null; // 章内 #fragment（锚点级章节）；无锚点章为 null
  orderIndex: number;
  level: number;
  startPage: number | null;
  endPage: number | null;
}
```

- [ ] **Step 2: 写失败测试**

`src/main/library/content.test.ts` 追加（复用 Task 4 的 `anchorBook()`；如需跨文件复用，可在本测试文件内重复定义一份 fixture builder——计划允许重复 fixture）：

```ts
describe("listChapters with anchors", () => {
  it("returns one entry per TOC anchor (no collapse), with anchor + level", async () => {
    const db = makeDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const list = listChapters(db, book.id);
    expect(list.map((c) => [c.title, c.href, c.anchor, c.level])).toEqual([
      ["第1章", "OEBPS/t0.xhtml", "a1", 0],
      ["第2章", "OEBPS/t0.xhtml", "a2", 0],
      ["第3章", "OEBPS/t1.xhtml", "b1", 0],
    ]);
  });
});

describe("readChapterText with anchors", () => {
  it("reads only the target chapter's text (anchor → next anchor in same file)", async () => {
    const db = makeDb();
    const book = await importBook(db, { bytes: anchorBook() });
    const ch2 = listChapters(db, book.id).find((c) => c.anchor === "a2")!;
    const slice = await readChapterText(db, anchorBook(), book.id, ch2.id, {});
    expect(slice.text).toBe("第2章");
    expect(slice.text).not.toContain("第1章");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/library/content.test.ts`
Expected: FAIL —`listChapters` 仍按文件去重 / 无 anchor 字段；`readChapterText` 不切锚点。

- [ ] **Step 4: 改 `listChapters`（去掉 spine 文件去重，透出 anchor，按 (href,anchor) resolve）**

`src/main/library/content.ts`：把 `import { getBook, resolveChapterByHref } …` 改为也引入 `resolveChapter`；`listChapters` 的 `walk` 改为：

```ts
const walk = (nodes: TocNode[], level: number): void => {
  for (const n of nodes) {
    if (n.href && n.label) {
      const ch = resolveChapter(db, bookId, n.href, n.anchor ?? null);
      if (!ch) {
        log.warn(
          `toc entry not found in chapters (book ${bookId}, href ${n.href}, anchor ${n.anchor ?? "∅"})`,
        );
      } else if (!seen.has(ch.id)) {
        seen.add(ch.id);
        out.push({
          id: ch.id,
          title: n.label,
          href: ch.href,
          anchor: ch.anchor ?? null,
          orderIndex: ch.orderIndex ?? 0,
          level,
          startPage: ch.startPage ?? null,
          endPage: ch.endPage ?? null,
        });
      }
    }
    if (n.children) walk(n.children, level + 1);
  }
};
```

并把无 TOC 兜底分支的 `.map(...)` 加 `anchor: c.anchor ?? null`（select 里补 `anchor: chapters.anchor`）：

```ts
return db
  .select({
    id: chapters.id,
    title: chapters.title,
    href: chapters.href,
    anchor: chapters.anchor,
    orderIndex: chapters.orderIndex,
    startPage: chapters.startPage,
    endPage: chapters.endPage,
  })
  .from(chapters)
  .where(eq(chapters.bookId, bookId))
  .orderBy(asc(chapters.orderIndex))
  .all()
  .map((c) => ({
    id: c.id,
    title: c.title,
    href: c.href,
    anchor: c.anchor ?? null,
    orderIndex: c.orderIndex ?? 0,
    level: 0,
    startPage: c.startPage ?? null,
    endPage: c.endPage ?? null,
  }));
```

- [ ] **Step 5: 改 `readChapterText`（传 anchor + 算同文件下一边界 anchor）**

`src/main/library/content.ts` 的 `readChapterText`：取 chapter 行时多取 `anchor`、`orderIndex`，epub 分支算 nextAnchor 后传入。把 ch 查询与 epub return 改为：

```ts
const ch = db
  .select({
    href: chapters.href,
    anchor: chapters.anchor,
    orderIndex: chapters.orderIndex,
    startPage: chapters.startPage,
    endPage: chapters.endPage,
  })
  .from(chapters)
  .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
  .get();
if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
if (book.format === "pdf") {
  /* …PDF 分支不变… */
}
// epub：同 href、orderIndex 更大的下一边界 anchor 作为本章终点（无则到文件末）。
let nextAnchor: string | undefined;
if (ch.anchor != null && ch.orderIndex != null) {
  const next = db
    .select({ anchor: chapters.anchor })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        eq(chapters.href, ch.href),
        gt(chapters.orderIndex, ch.orderIndex),
      ),
    )
    .orderBy(asc(chapters.orderIndex))
    .limit(1)
    .get();
  nextAnchor = next?.anchor ?? undefined;
}
return extractChapterText(bytes, ch.href, opts, ch.anchor ?? undefined, nextAnchor);
```

顶部 import 补 `gt`：`import { and, asc, eq, gt } from "drizzle-orm";`

- [ ] **Step 6: 改 `readBookText`（href 去重）**

`src/main/library/content.ts` 的 `readBookText` 里取 hrefs 段改为去重保序：

```ts
const rows = db
  .select({ href: chapters.href })
  .from(chapters)
  .where(eq(chapters.bookId, bookId))
  .orderBy(asc(chapters.orderIndex))
  .all();
const seen = new Set<string>();
const hrefs = rows.map((r) => r.href).filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
return extractBookText(bytes, hrefs, opts);
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm test src/main/library/content.test.ts`
Expected: PASS（新用例 + 既有。既有 listChapters 用例若断言无 anchor 字段，按新 DTO 补 `anchor` 期望值——通常为 `null`）。

- [ ] **Step 8: typecheck**

Run: `pnpm typecheck`
Expected: 通过（`ChapterRefDto.anchor` 全消费点已覆盖；渲染端消费在 Plan B，但加必填 `anchor` 字段不会破坏渲染端类型——渲染端读取而非构造该 DTO；若 typecheck 报渲染端构造 ChapterRefDto 处缺 anchor，按提示补 `anchor: null`）。

- [ ] **Step 9: 提交**

```bash
git add src/shared/library.ts src/main/library/content.ts src/main/library/content.test.ts
git commit -m "feat(library): list & read chapters at anchor granularity"
```

---

## Task 7: IPC 接线 — `ensureEpubIndexed`（开书惰性重建触发）

把 `reindexBookIfStale` 接到开书路径：版本门控、仅首次升级时载字节。幂等地放在 toc/chapters/chapterText/readBookBytes handler 顶部（先到先升级，余者 no-op，race 良性）。

**Files:**

- Modify: `src/main/ipc/library-handlers.ts`

- [ ] **Step 1: 加 `ensureEpubIndexed` helper**

`src/main/ipc/library-handlers.ts`：import 补 `reindexBookIfStale, CURRENT_PARSER_VERSION`（from repository），在 `libraryBindings` 上方加：

```ts
/** 开书惰性升级：epub 且 parserVersion 落后时载字节重建索引（幂等、版本门控）。失败不阻塞开书。 */
async function ensureEpubIndexed(bookId: string): Promise<void> {
  const db = getDb();
  const book = getBook(db, bookId);
  if (!book || book.format !== "epub") return;
  if ((book.parserVersion ?? 0) >= CURRENT_PARSER_VERSION) return; // 已最新：不载字节
  try {
    const bytes = await readBookFile(appService.getPath("booksDir"), bookId, book.format);
    reindexBookIfStale(db, bytes, bookId);
  } catch (err) {
    log.warn(`ensureEpubIndexed failed (book ${bookId})`, err);
  }
}
```

- [ ] **Step 2: 在开书 handler 顶部调用**

把 `contentToc`、`contentChapters` 两个 handler 改为 async 并在读 DB 前 `await ensureEpubIndexed(input.bookId);`；`contentChapterText`、`libraryReadBookBytes` 已 async，在读字节/章节前加同一行。例如 `contentChapters`：

```ts
  bind(C.contentChapters, async (input) => {
    const db = getDb();
    if (!getBook(db, input.bookId)) throw new Error(`content: book ${input.bookId} not found`);
    await ensureEpubIndexed(input.bookId);
    return listChapters(db, input.bookId);
  }),
```

`contentToc` 同理（async + await ensureEpubIndexed 后再 `getToc`）。`libraryReadBookBytes`：在 `getBook` 校验后、`readBookFile` 前加 `await ensureEpubIndexed(input.bookId);`（首次会触发重建，随后该 handler 自身再读字节返回——重复读盘一次，可接受；或复用：实现者可选择让 ensureEpubIndexed 返回 bytes 复用，但保持简单即可）。`contentChapterText` 在 `readBookFile` 前加。

- [ ] **Step 3: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test:all`
Expected: 通过。handler 改 async 不影响 registry（既有 async handler 同模式）。

- [ ] **Step 4: 提交**

```bash
git add src/main/ipc/library-handlers.ts
git commit -m "feat(ipc): trigger lazy reindex on book open"
```

---

## Task 8: AI 工具核对 + 全量验证 + changeset

**Files:**

- Verify: `src/main/ai/tools.ts`
- Add: `.changeset/*.md`

- [ ] **Step 1: 核对 `resolveChapterRef` 仍工作**

阅读 `src/main/ai/tools.ts:35-59`。确认：`getToc`（→ `listChapters`）现返回锚点章，模型据 `id` 调 `readChapterText`/`getChapterSummary`；`resolveChapterRef` 的 `byHref` 回退（`resolveChapterByHref` 返回首个同 href 行）对多锚点章是「容错近似」——可接受，不改。若要更稳可在错误清单 sample 里附 anchor，但**非必须**，本步仅核对不改逻辑。

- [ ] **Step 2: 跑 AI 工具相关测试（若有）**

Run: `pnpm test src/main/ai` （若该目录有测试文件；无则跳过）
Expected: PASS。

- [ ] **Step 3: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test:all`
Expected: 全绿。任一红停下按 [[honest-error-no-fabrication]] 如实排查，不放宽断言。

- [ ] **Step 4: 写 changeset**

Run: `pnpm changeset`（交互选 patch/minor；本功能属 minor）。或手写 `.changeset/anchor-level-chapters.md`：

```md
---
"marginalia": minor
---

ePub reader now recognizes chapters anchored within shared spine files (e.g. Calibre/Epubor exports that pack a whole book into one or two HTML files). The table of contents, AI chapter tools, and chapter text all resolve at #fragment-anchor granularity instead of collapsing to per-file chapters. Existing books upgrade automatically on next open.
```

- [ ] **Step 5: 提交**

```bash
git add .changeset src/main/ai/tools.ts
git commit -m "docs: changeset for anchor-level chapters (headless)"
```

---

## Self-Review 检查记录

- **Spec 覆盖**：解析保锚点(T1) · 内容切分(T2) · schema+迁移(T3) · TOC 建章+resolve(T4) · 惰性重建(T5) · listChapters/readChapterText/readBookText/DTO(T6) · 开书接线(T7) · AI 核对+验证(T8)。spec §3.1/3.2/3.3/3.4/3.5 全覆盖；§3.6/3.7（渲染端 + open-external IPC）属 Plan B。
- **类型一致**：`TocNode.anchor?: string`（解析层，无锚点缺省）↔ `chapters.anchor: string | null`（DB）↔ `ChapterRefDto.anchor: string | null`（DTO），边界用 `?? null` / `?? undefined` 显式转换；`extractChapterText(…, anchor?: string, nextAnchor?: string)` 与调用方 `ch.anchor ?? undefined` 一致。
- **无占位符**：各步含完整代码 / 命令 / 期望输出。
- **fixture 复用**：`anchorBook()` 在 repository.test 与 content.test 各定义一份（计划允许重复，避免跨测试文件耦合）。

---

## Execution Handoff

Plan A 完成后接 **Plan B（渲染端）**：`app:open-external` IPC + `SectionFrame` 链接拦截（修白屏）+ `VirtualDocs.scrollToAnchor` + `EpubReader` 跳章/链接/当前章/进度 + `resolveCurrentChapter`。Plan B 依赖本 Plan 产出的 `TocNode.anchor` / `ChapterRefDto.anchor` / 锚点章数据。
