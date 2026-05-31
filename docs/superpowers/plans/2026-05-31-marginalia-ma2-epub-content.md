# Marginalia MA2 · ePub 解析库 + 内容仓库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 ePub 解析封装成独立的框架无关库 `@marginalia/epub-parser`（放 `packages/`，字节进/数据出，纯 JS、headless 可测）；main 侧消费它实现「导入 → books+chapters」、library/progress 仓库、按章原文读取与 TOC/摘要访问器，经 `window.api` 暴露。仍无真实 renderer UI。

**Architecture:** 三层——①**独立解析库**（`packages/epub-parser`）：纯函数，无 Electron/DB/fs 依赖，只做「字节 → ParsedEpub」与「字节+href → 章节纯文本」；②**main 仓库/服务层**（`src/main`）：注入 `DB`，调用解析库 + 落库/读库；③**IPC**：MA1 的 `handle()` 注册。pnpm workspace 串联。

**Tech Stack（新增）:** 库内 `fflate`（解压）+ `fast-xml-parser`（OPF/NCX/nav）+ `node-html-parser`（XHTML→文本），纯 JS 无原生 ABI。沿用 MA1 的 Drizzle/better-sqlite3/Zod/vitest/uuid。

---

## ⚠️ Setup 决策（已据你"封装成库放 packages"定，执行前请核对）

1. **解析栈**：`fflate` + `fast-xml-parser` + `node-html-parser`（手写、纯 JS）。✅ 已确认。
2. **封装为独立包**：`packages/epub-parser`，包名 **`@marginalia/epub-parser`**（与根 `marginalia` 同 scope）。库**只含纯解析/文本提取**，不碰 DB/Electron/fs。
3. **monorepo / workspace**：新增根 `pnpm-workspace.yaml`，纳入 `packages/*` 但**排除 `packages/ui-prototype`**（它是带独立 lock 的原型，不并入）。根应用以 `"@marginalia/epub-parser": "workspace:*"` 依赖它。
4. **不单独构建**：包以 **TS 源码直链**（`main`/`types` 指向 `./src/index.ts`）；Vite（main 进程打包）与 vitest 都能转译 TS，无需 build 步骤。
5. **TocNode 归属**：`TocNode` 类型由库定义；`src/shared/types.ts` **re-export** 它，并新增 `tocNodeSchema`（Zod，供 DB JSON parse-on-read——这并入了 PR #1 review 的 defer 项）。
6. **分支基点**：MA1 已合并 main；从 **main 切 `feat/ma2-epub-content`**。
7. **导入幂等**：`importBook` 首次导入或跳过——`books.id` 已在库则直接返回、不重新解析、不动 chapters（零 churn）。无 uid 的书用内容哈希作 id，文件一变即成新书。"显式刷新/重新导入"留后续里程碑（按 `(book_id, href)` 稳定 upsert 保 chapter id 不变）。

> 若你想改包名/workspace 范围/构建方式，告诉我，相应任务的 package.json 与 import 路径需调整。

---

## 已知约束（沿用 MA1 + workspace）

1. `pnpm`/`pnpx`（不要 npx）。改了 workspace/依赖后跑 `pnpm install` 让 `@marginalia/epub-parser` 软链进 `node_modules`。
2. better-sqlite3 ABI 双轨：跑 app 侧 vitest 前 `pnpm db:rebuild:node`；不要 `pnpm start`。解析库三依赖纯 JS 无此问题。
3. prek 预提交（oxlint+oxfmt）可能重排并中断提交 → `git add -A` 再 `git commit`。
4. 不用 `git -C`。
5. 本里程碑无真实 UI。IPC 仅靠 vitest 验证业务逻辑。
6. **测试运行**：包有自己的 `vitest`（测 `packages/epub-parser/src`）；根 `pnpm test` 测应用。新增根脚本 `test:all`（`pnpm -r test`）一次跑全部。

---

## 文件结构

**新增包 `packages/epub-parser/`（纯库）**

- `package.json`（`@marginalia/epub-parser`, type:module, 源码直链, deps: fflate/fast-xml-parser/node-html-parser）
- `tsconfig.json`、`vitest.config.ts`
- `src/types.ts` — `SpineItem` / `ParsedEpub` / `TocNode`
- `src/parse.ts` — `parseEpub(bytes): ParsedEpub`
- `src/content.ts` — `htmlToText(xhtml)`、`extractChapterText(bytes, href, opts): ChapterTextSlice`
- `src/fixture.ts` — `makeFixtureEpub(): Uint8Array`（导出供消费方测试复用）
- `src/index.ts` — barrel 导出
- `src/{parse,content,fixture}.test.ts`

**根（修改）**

- `pnpm-workspace.yaml`（新增）
- `package.json` — 加依赖 `@marginalia/epub-parser: workspace:*` + 脚本 `test:all`
- `src/shared/types.ts` — re-export `TocNode` + 新增 `tocNodeSchema`
- `src/shared/ipc.ts` — 增 library/progress/content 通道名
- `src/main.ts` — ready 时加 `registerLibraryHandlers()`

**main（新增，消费库）**

- `src/shared/library.ts` — IPC 入/出 Zod schema + 类型
- `src/main/library/repository.ts` — `importBook`/`listBooks`/`getBook`/`resolveChapterByHref`
- `src/main/library/progress.ts` — `getProgress`/`saveProgress`
- `src/main/library/content.ts` — `getToc`/`getChapterSummary`/`readChapterText`（DB + 调用库 + 读文件）
- `src/main/ipc/library-handlers.ts` — 注册通道
- 对应 `*.test.ts`

> 复用 MA1：`@main/db/{client,instance,schema}`、`@main/ipc/registry`、`@shared/*`。

---

## Task 1: workspace + `@marginalia/epub-parser` 包脚手架 + 夹具

**Files:** Create `pnpm-workspace.yaml`、`packages/epub-parser/{package.json,tsconfig.json,vitest.config.ts,src/types.ts,src/fixture.ts,src/index.ts,src/fixture.test.ts}`; Modify root `package.json`

- [ ] **Step 1: 创建 `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "!packages/ui-prototype"
```

- [ ] **Step 2: 创建 `packages/epub-parser/package.json`**

```json
{
  "name": "@marginalia/epub-parser",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fast-xml-parser": "^5.0.0",
    "fflate": "^0.8.2",
    "node-html-parser": "^7.0.1"
  },
  "devDependencies": {
    "typescript": "~6.0.3",
    "vitest": "^4.1.7"
  }
}
```

> 版本号以 `pnpm add` 实装为准；上面是占位，安装时会写成实际版本。

- [ ] **Step 3: 创建 `packages/epub-parser/tsconfig.json`**

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
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 创建 `packages/epub-parser/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", globals: true },
});
```

- [ ] **Step 5: 安装依赖（在包目录）+ 软链 workspace**

```bash
pnpm --filter @marginalia/epub-parser add fflate fast-xml-parser node-html-parser
pnpm --filter @marginalia/epub-parser add -D typescript vitest
```

然后在根 `package.json` 的 `dependencies` 加 `"@marginalia/epub-parser": "workspace:*"`，并在 `scripts` 加 `"test:all": "pnpm -r test"`，再：

```bash
pnpm install
```

Expected: `node_modules/@marginalia/epub-parser` 软链到 `packages/epub-parser`。

- [ ] **Step 6: 创建 `packages/epub-parser/src/types.ts`**

```ts
/** ePub 目录树节点 */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

/** spine 项：id 为 manifest item id（书内唯一）；href 已解析为包内绝对路径 */
export interface SpineItem {
  id: string;
  href: string;
}

/** parseEpub 的产物 */
export interface ParsedEpub {
  uid: string; // dc:identifier；缺失时由消费方回退文件哈希
  title?: string;
  author?: string;
  cover?: Uint8Array;
  spine: SpineItem[];
  toc: TocNode[];
}
```

- [ ] **Step 7: 创建 `packages/epub-parser/src/fixture.ts`**

（内容同前一版的 `makeFixtureEpub`——构造含 nav + 两章 + 1x1 PNG 封面的最小 EPUB3。完整代码：）

```ts
import { strToU8, zipSync } from "fflate";

/** 构造最小但结构合法的 EPUB3 字节流，供解析/内容测试与消费方复用。 */
export function makeFixtureEpub(): Uint8Array {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:fixture-001</dc:identifier>
    <dc:title>Fixture Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="ch1.xhtml">Chapter One</a></li>
    <li><a href="ch2.xhtml">Chapter Two</a></li>
  </ol></nav></body>
</html>`;
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Hello world.</p><p>Second paragraph.</p></body></html>`;
  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter Two</h1><p>The end.</p></body></html>`;
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/ch1.xhtml": strToU8(ch1),
    "OEBPS/ch2.xhtml": strToU8(ch2),
    "OEBPS/cover.png": png,
  });
}
```

- [ ] **Step 8: 创建 `packages/epub-parser/src/index.ts`**（暂只导出已有的；后续任务补 parse/content）

```ts
export { makeFixtureEpub } from "./fixture";
export type { ParsedEpub, SpineItem, TocNode } from "./types";
```

- [ ] **Step 9: 写夹具测试 `packages/epub-parser/src/fixture.test.ts`**

```ts
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";

describe("makeFixtureEpub", () => {
  it("produces a zip with the expected entries", () => {
    const files = unzipSync(makeFixtureEpub());
    expect(Object.keys(files).sort()).toEqual(
      [
        "META-INF/container.xml",
        "OEBPS/ch1.xhtml",
        "OEBPS/ch2.xhtml",
        "OEBPS/content.opf",
        "OEBPS/cover.png",
        "OEBPS/nav.xhtml",
        "mimetype",
      ].sort(),
    );
  });
});
```

- [ ] **Step 10: 运行 + 提交**
      Run: `pnpm --filter @marginalia/epub-parser test` → PASS。 `pnpm --filter @marginalia/epub-parser typecheck` → clean。 根 `pnpm typecheck` → clean。

```bash
git add -A
git commit -m "feat(ma2): scaffold @marginalia/epub-parser workspace package + fixture"
```

---

## Task 2: 解析核心 `parse.ts`（包内）

**Files:** Create `packages/epub-parser/src/parse.ts`、`packages/epub-parser/src/parse.test.ts`; Modify `packages/epub-parser/src/index.ts`

- [ ] **Step 1: 写失败测试 `parse.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";
import { parseEpub } from "./parse";

describe("parseEpub", () => {
  const parsed = () => parseEpub(makeFixtureEpub());

  it("reads metadata", () => {
    const p = parsed();
    expect(p.uid).toBe("urn:uuid:fixture-001");
    expect(p.title).toBe("Fixture Book");
    expect(p.author).toBe("Test Author");
    expect(p.cover && p.cover.byteLength).toBeGreaterThan(0);
  });

  it("reads spine in order with resolved hrefs", () => {
    const p = parsed();
    expect(p.spine.map((s) => s.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(p.spine.map((s) => s.id)).toEqual(["ch1", "ch2"]);
  });

  it("reads the EPUB3 nav TOC", () => {
    expect(parsed().toc).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });
});
```

- [ ] **Step 2: 运行（验证失败）** — `pnpm --filter @marginalia/epub-parser test` → FAIL（`./parse` 不存在）。

- [ ] **Step 3: 创建 `packages/epub-parser/src/parse.ts`**

```ts
import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import type { ParsedEpub, SpineItem, TocNode } from "./types";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["item", "itemref", "navPoint"].includes(name),
});

function resolveHref(baseDir: string, href: string): string {
  const stack = baseDir ? baseDir.split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v)
    return String((v as { "#text": unknown })["#text"]);
  return undefined;
}

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  const files = unzipSync(bytes);
  const text = (p: string): string => {
    const b = files[p];
    if (!b) throw new Error(`epub: missing entry ${p}`);
    return strFromU8(b);
  };

  const container = xml.parse(text("META-INF/container.xml"));
  const opfPath: string | undefined = container?.container?.rootfiles?.rootfile?.["@_full-path"];
  if (!opfPath) throw new Error("epub: cannot locate OPF rootfile");
  const opfDir = dirOf(opfPath);

  const pkg = xml.parse(text(opfPath)).package;
  const meta = pkg.metadata ?? {};
  const uniqueId: string | undefined = pkg["@_unique-identifier"];

  const identifiers = asArray(meta.identifier);
  const uid =
    textOf(identifiers.find((i) => typeof i === "object" && i?.["@_id"] === uniqueId)) ??
    textOf(identifiers[0]) ??
    "";
  const title = textOf(asArray(meta.title)[0]);
  const author = textOf(asArray(meta.creator)[0]);

  const manifest = new Map<string, { href: string; properties: string }>();
  for (const it of asArray(pkg.manifest?.item)) {
    manifest.set(it["@_id"], {
      href: resolveHref(opfDir, it["@_href"]),
      properties: it["@_properties"] ?? "",
    });
  }

  const spine: SpineItem[] = asArray(pkg.spine?.itemref)
    .map((ref) => {
      const id = ref["@_idref"];
      const m = manifest.get(id);
      return m ? { id, href: m.href } : undefined;
    })
    .filter((s): s is SpineItem => s !== undefined);

  let coverHref: string | undefined;
  for (const [, m] of manifest)
    if (m.properties.split(/\s+/).includes("cover-image")) coverHref = m.href;
  if (!coverHref) {
    const coverId = asArray(meta.meta).find((m) => m?.["@_name"] === "cover")?.["@_content"];
    if (coverId) coverHref = manifest.get(coverId)?.href;
  }
  const cover = coverHref ? files[coverHref] : undefined;

  const toc = readToc(pkg, manifest, text);
  return { uid, title, author, cover, spine, toc };
}

function readToc(
  pkg: { spine?: { "@_toc"?: string } },
  manifest: Map<string, { href: string; properties: string }>,
  text: (p: string) => string,
): TocNode[] {
  // EPUB3 nav
  for (const [, m] of manifest) {
    if (m.properties.split(/\s+/).includes("nav")) {
      const root = parseHtml(text(m.href));
      const navEl = root.querySelector("nav") ?? root;
      const ol = navEl.querySelector("ol");
      const navDir = dirOf(m.href);
      const walk = (listEl: typeof ol): TocNode[] => {
        if (!listEl) return [];
        return listEl
          .querySelectorAll("li")
          .filter((li) => li.parentNode === listEl)
          .map((li) => {
            const a = li.querySelector("a");
            const childOl = li.querySelectorAll("ol").find((o) => o.parentNode === li);
            const href = a?.getAttribute("href")?.split("#")[0] ?? "";
            const node: TocNode = {
              label: (a?.text ?? "").trim(),
              href: href ? resolveHref(navDir, href) : "",
            };
            const children = walk(childOl ?? null);
            if (children.length) node.children = children;
            return node;
          })
          .filter((n) => n.label || n.href);
      };
      return walk(ol);
    }
  }
  // EPUB2 NCX
  const ncxId = pkg.spine?.["@_toc"];
  const ncx = ncxId ? manifest.get(ncxId) : undefined;
  if (ncx) {
    const doc = xml.parse(text(ncx.href));
    const ncxDir = dirOf(ncx.href);
    const toNode = (np: {
      navLabel?: { text?: string };
      content?: { "@_src"?: string };
      navPoint?: unknown;
    }): TocNode => {
      const src = np.content?.["@_src"]?.split("#")[0] ?? "";
      const node: TocNode = {
        label: (np.navLabel?.text ?? "").toString().trim(),
        href: src ? resolveHref(ncxDir, src) : "",
      };
      const kids = asArray(np.navPoint).map(toNode);
      if (kids.length) node.children = kids;
      return node;
    };
    return asArray(doc.ncx?.navMap?.navPoint).map(toNode);
  }
  return [];
}
```

> `node-html-parser` 无 `:scope` 选择器，故用 `querySelectorAll(...).filter(parentNode === listEl)` 取直接子节点。若该 API 细节有出入，以 `parse.test.ts` 为准调整，勿改测试期望。

- [ ] **Step 4: 把 parse 加入 barrel `src/index.ts`**：补 `export { parseEpub } from "./parse";`

- [ ] **Step 5: 运行（验证通过）+ typecheck + 提交**

```bash
pnpm --filter @marginalia/epub-parser test
pnpm --filter @marginalia/epub-parser typecheck
git add -A
git commit -m "feat(ma2): parseEpub (OPF/spine/metadata/nav+NCX TOC) in epub-parser package"
```

---

## Task 3: 章节文本提取 `content.ts`（包内）

**Files:** Create `packages/epub-parser/src/content.ts`、`packages/epub-parser/src/content.test.ts`; Modify `src/index.ts`

- [ ] **Step 1: 写失败测试 `content.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { extractChapterText, htmlToText } from "./content";
import { makeFixtureEpub } from "./fixture";

describe("htmlToText", () => {
  it("joins block text with newlines and collapses whitespace", () => {
    const t = htmlToText(`<html><body><h1>Title</h1><p>A  b</p><p>c</p></body></html>`);
    expect(t).toBe("Title\nA b\nc");
  });
});

describe("extractChapterText", () => {
  const bytes = makeFixtureEpub();
  it("extracts plain text from a chapter href", () => {
    const r = extractChapterText(bytes, "OEBPS/ch1.xhtml", {});
    expect(r.text).toContain("Chapter One");
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("paginates by maxChars", () => {
    const r = extractChapterText(bytes, "OEBPS/ch1.xhtml", { offset: 0, maxChars: 5 });
    expect(r.text.length).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(5);
  });
  it("throws on a missing entry", () => {
    expect(() => extractChapterText(bytes, "OEBPS/nope.xhtml", {})).toThrow(/missing entry/);
  });
});
```

- [ ] **Step 2: 运行（验证失败）** — FAIL（`./content` 不存在）。

- [ ] **Step 3: 创建 `packages/epub-parser/src/content.ts`**

```ts
import { strFromU8, unzipSync } from "fflate";
import { parse as parseHtml } from "node-html-parser";

export interface ReadOptions {
  offset?: number;
  maxChars?: number;
}
export interface ChapterTextSlice {
  text: string;
  hasMore: boolean;
  nextOffset: number;
}

const DEFAULT_MAX_CHARS = 20_000;

/** XHTML → 纯文本：块级元素文本，块间换行，规整空白。 */
export function htmlToText(xhtml: string): string {
  const root = parseHtml(xhtml);
  const body = root.querySelector("body") ?? root;
  const blocks = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre");
  const parts = (blocks.length ? blocks.map((b) => b.text) : [body.text])
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join("\n");
}

/** 从 ePub 字节里取某 href 的章节纯文本（分页）。纯函数：不碰 DB/fs。 */
export function extractChapterText(
  bytes: Uint8Array,
  href: string,
  opts: ReadOptions,
): ChapterTextSlice {
  const files = unzipSync(bytes);
  const entry = files[href];
  if (!entry) throw new Error(`epub: missing entry ${href}`);
  const full = htmlToText(strFromU8(entry));
  const offset = Math.max(0, opts.offset ?? 0);
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const slice = full.slice(offset, offset + maxChars);
  const nextOffset = offset + slice.length;
  return { text: slice, hasMore: nextOffset < full.length, nextOffset };
}
```

- [ ] **Step 4: barrel 补** `export { extractChapterText, htmlToText } from "./content"; export type { ChapterTextSlice, ReadOptions } from "./content";`

- [ ] **Step 5: 运行（验证通过）+ 提交**

```bash
pnpm --filter @marginalia/epub-parser test
pnpm --filter @marginalia/epub-parser typecheck
git add -A
git commit -m "feat(ma2): chapter text extraction (htmlToText + paginated extractChapterText)"
```

---

## Task 4: shared schema/类型 + Library 仓库（应用侧消费库）

**Files:** Create `src/shared/library.ts`、`src/main/library/repository.ts`、`src/main/library/repository.test.ts`; Modify `src/shared/types.ts`、`src/shared/ipc.ts`

- [ ] **Step 1: 修改 `src/shared/types.ts`** —— TocNode 改为 re-export 库定义 + 新增 Zod schema（并入 review 的 defer 项）：

```ts
import { z } from "zod";
import type { TocNode } from "@marginalia/epub-parser";

export type { TocNode };

/** DB JSON 列 parse-on-read 用 */
export const tocNodeSchema: z.ZodType<TocNode> = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    children: z.array(tocNodeSchema).optional(),
  }),
);
```

（保留文件里原有的 `messageMetadataSchema` / `MessageMetadata` 不动。删除原来的 `TocNode` interface 定义，改用上面的 re-export。）

- [ ] **Step 2: 在 `src/shared/ipc.ts` 的 `IPC` 增通道名**（追加键，保留现有）：

```ts
  libraryImport: "library:import",
  libraryList: "library:list",
  libraryGet: "library:get",
  progressGet: "progress:get",
  progressSave: "progress:save",
  contentToc: "content:toc",
  contentChapterText: "content:chapter-text",
  contentChapterSummary: "content:chapter-summary",
```

- [ ] **Step 3: 创建 `src/shared/library.ts`**

```ts
import { z } from "zod";

export const importBookInput = z.object({ filePath: z.string().min(1) });
export type ImportBookInput = z.infer<typeof importBookInput>;

export const bookIdInput = z.object({ bookId: z.string().min(1) });
export type BookIdInput = z.infer<typeof bookIdInput>;

export const saveProgressInput = z.object({ bookId: z.string().min(1), cfi: z.string().min(1) });
export type SaveProgressInput = z.infer<typeof saveProgressInput>;

export const chapterRefInput = z.object({
  bookId: z.string().min(1),
  chapterId: z.string().min(1),
});
export type ChapterRefInput = z.infer<typeof chapterRefInput>;

export const readChapterTextInput = chapterRefInput.extend({
  offset: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
});
export type ReadChapterTextInput = z.infer<typeof readChapterTextInput>;

export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
}
```

- [ ] **Step 4: 写失败测试 `src/main/library/repository.test.ts`**

```ts
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getBook, importBook, listBooks, resolveChapterByHref } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("library repository", () => {
  it("imports a book and persists metadata + ordered chapters (pending)", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub(), filePath: "/books/fixture.epub" });
    expect(book.id).toBe("urn:uuid:fixture-001");
    expect(book.title).toBe("Fixture Book");
    expect(getBook(db, book.id)?.path).toBe("/books/fixture.epub");
    expect(listBooks(db)).toHaveLength(1);

    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml");
    const ch2 = resolveChapterByHref(db, book.id, "OEBPS/ch2.xhtml");
    expect(ch1?.orderIndex).toBe(0);
    expect(ch2?.orderIndex).toBe(1);
    expect(ch1?.title).toBe("Chapter One");
    expect(ch1?.summaryStatus).toBe("pending");
    expect(ch1?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("uses a content hash id when uid is absent (sanity of fallback math)", () => {
    const bytes = makeFixtureEpub();
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  });
});
```

- [ ] **Step 5: 运行（验证失败）** — `pnpm db:rebuild:node && pnpm test src/main/library/repository.test.ts` → FAIL（模块不存在）。

- [ ] **Step 6: 创建 `src/main/library/repository.ts`**

```ts
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseEpub, type TocNode } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";

export interface ImportInput {
  bytes: Uint8Array;
  filePath: string;
}
export type BookRow = typeof books.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;

function tocLabelByHref(toc: TocNode[], acc = new Map<string, string>()): Map<string, string> {
  for (const n of toc) {
    if (n.href && !acc.has(n.href)) acc.set(n.href, n.label);
    if (n.children) tocLabelByHref(n.children, acc);
  }
  return acc;
}

export function importBook(db: DB, input: ImportInput): BookRow {
  const parsed = parseEpub(input.bytes);
  const id = parsed.uid || createHash("sha256").update(input.bytes).digest("hex");

  // 幂等：已在库则直接返回，不重新解析、不动 chapters（零 churn）。
  // "显式刷新/重新导入"留后续里程碑：届时按 (book_id, href) 稳定 upsert，
  // 保 chapter id 不变，供 MA4 章节绑定会话存活。
  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  db.insert(books)
    .values({
      id,
      path: input.filePath,
      title: parsed.title ?? null,
      author: parsed.author ?? null,
      cover: parsed.cover ? Buffer.from(parsed.cover) : null,
      toc: parsed.toc,
    })
    .run();

  const labels = tocLabelByHref(parsed.toc);
  parsed.spine.forEach((item, index) => {
    db.insert(chapters)
      .values({
        bookId: id,
        href: item.href,
        orderIndex: index,
        title: labels.get(item.href) ?? null,
        summaryStatus: "pending",
      })
      .run();
  });

  const row = db.select().from(books).where(eq(books.id, id)).get();
  if (!row) throw new Error("importBook: book row missing after insert");
  return row;
}

export function listBooks(db: DB): BookRow[] {
  return db.select().from(books).all();
}
export function getBook(db: DB, id: string): BookRow | undefined {
  return db.select().from(books).where(eq(books.id, id)).get();
}
export function resolveChapterByHref(db: DB, bookId: string, href: string): ChapterRow | undefined {
  return db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.href, href)))
    .get();
}
```

- [ ] **Step 7: 运行（验证通过）+ typecheck + 提交**

```bash
pnpm db:rebuild:node && pnpm test src/main/library/repository.test.ts
pnpm typecheck
git add -A
git commit -m "feat(ma2): shared library schemas + library repository consuming epub-parser"
```

---

## Task 5: Progress 仓库

**Files:** Create `src/main/library/progress.ts`、`src/main/library/progress.test.ts`

- [ ] **Step 1: 写失败测试 `progress.test.ts`**

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { getProgress, saveProgress } from "@main/library/progress";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = importBook(db, { bytes: makeFixtureEpub(), filePath: "/b.epub" });
  return { db, book };
};

describe("progress repository", () => {
  it("returns undefined when nothing saved", () => {
    const { db, book } = setup();
    expect(getProgress(db, book.id)).toBeUndefined();
  });
  it("upserts cfi", () => {
    const { db, book } = setup();
    saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)");
    expect(getProgress(db, book.id)?.cfi).toBe("epubcfi(/6/2!/4/1:0)");
    saveProgress(db, book.id, "epubcfi(/6/4!/4/1:0)");
    expect(getProgress(db, book.id)?.cfi).toBe("epubcfi(/6/4!/4/1:0)");
  });
});
```

- [ ] **Step 2: 运行（验证失败）** → FAIL。

- [ ] **Step 3: 创建 `src/main/library/progress.ts`**

```ts
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { progress } from "@main/db/schema";

export type ProgressRow = typeof progress.$inferSelect;

export function getProgress(db: DB, bookId: string): ProgressRow | undefined {
  return db.select().from(progress).where(eq(progress.bookId, bookId)).get();
}
export function saveProgress(db: DB, bookId: string, cfi: string): void {
  db.insert(progress)
    .values({ bookId, cfi, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: progress.bookId, set: { cfi, updatedAt: Date.now() } })
    .run();
}
```

- [ ] **Step 4: 运行（验证通过）+ 提交**

```bash
pnpm db:rebuild:node && pnpm test src/main/library/progress.test.ts
git add -A
git commit -m "feat(ma2): progress repository (upsert cfi by book)"
```

---

## Task 6: 内容服务 + IPC handlers

**Files:** Create `src/main/library/content.ts`、`src/main/library/content.test.ts`、`src/main/ipc/library-handlers.ts`; Modify `src/main.ts`

- [ ] **Step 1: 写失败测试 `src/main/library/content.test.ts`**

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { getChapterSummary, getToc, readChapterText } from "@main/library/content";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  return { db, bytes, book };
};

describe("content service", () => {
  it("getToc returns the stored, schema-validated toc", () => {
    const { db, book } = setup();
    expect(getToc(db, book.id)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });
  it("readChapterText returns plain text via the parser package", () => {
    const { db, bytes, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = readChapterText(db, bytes, book.id, ch1.id, {});
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("getChapterSummary returns pending by default", () => {
    const { db, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    expect(getChapterSummary(db, book.id, ch1.id)).toEqual({ status: "pending", summary: null });
  });
});
```

- [ ] **Step 2: 运行（验证失败）** → FAIL。

- [ ] **Step 3: 创建 `src/main/library/content.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { extractChapterText, type ChapterTextSlice } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { tocNodeSchema, type TocNode } from "@shared/types";

export interface ChapterSummary {
  status: "pending" | "generating" | "ready" | "unavailable";
  summary: string | null;
}

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  return (row?.toc ?? []).filter((n) => tocNodeSchema.safeParse(n).success);
}

export function getChapterSummary(db: DB, bookId: string, chapterId: string): ChapterSummary {
  const row = db
    .select({ summary: chapters.summary, status: chapters.summaryStatus })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return { status: row.status, summary: row.summary ?? null };
}

export function readChapterText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
  opts: { offset?: number; maxChars?: number },
): ChapterTextSlice {
  const ch = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return extractChapterText(bytes, ch.href, opts);
}
```

- [ ] **Step 4: 运行（验证通过）** → PASS。

- [ ] **Step 5: 创建 `src/main/ipc/library-handlers.ts`**

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  IPC,
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  type BookSummaryDto,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import { getDb } from "@main/db/instance";
import { getBook, importBook, listBooks } from "@main/library/repository";
import { getProgress, saveProgress } from "@main/library/progress";
import {
  getChapterSummary,
  getToc,
  readChapterText,
  type ChapterSummary,
} from "@main/library/content";
import { handle } from "@main/ipc/registry";
import type { ChapterTextSlice } from "@marginalia/epub-parser";

const toDto = (b: {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
}): BookSummaryDto => ({
  id: b.id,
  title: b.title,
  author: b.author,
  path: b.path,
});

export function registerLibraryHandlers(): void {
  handle<{ filePath: string }, BookSummaryDto>(
    IPC.libraryImport,
    importBookInput,
    async (input) => {
      const bytes = new Uint8Array(await readFile(input.filePath));
      return toDto(importBook(getDb(), { bytes, filePath: input.filePath }));
    },
  );

  handle<void, BookSummaryDto[]>(IPC.libraryList, z.void(), () => listBooks(getDb()).map(toDto));

  handle<{ bookId: string }, BookSummaryDto | null>(IPC.libraryGet, bookIdInput, (input) => {
    const b = getBook(getDb(), input.bookId);
    return b ? toDto(b) : null;
  });

  handle<{ bookId: string }, { cfi: string } | null>(IPC.progressGet, bookIdInput, (input) => {
    const p = getProgress(getDb(), input.bookId);
    return p ? { cfi: p.cfi } : null;
  });

  handle<{ bookId: string; cfi: string }, void>(IPC.progressSave, saveProgressInput, (input) => {
    saveProgress(getDb(), input.bookId, input.cfi);
  });

  handle<{ bookId: string }, TocNode[]>(IPC.contentToc, bookIdInput, (input) =>
    getToc(getDb(), input.bookId),
  );

  handle<{ bookId: string; chapterId: string }, ChapterSummary>(
    IPC.contentChapterSummary,
    chapterRefInput,
    (input) => getChapterSummary(getDb(), input.bookId, input.chapterId),
  );

  handle<
    { bookId: string; chapterId: string; offset?: number; maxChars?: number },
    ChapterTextSlice
  >(IPC.contentChapterText, readChapterTextInput, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`content: book ${input.bookId} not found`);
    const bytes = new Uint8Array(await readFile(book.path));
    return readChapterText(db, bytes, input.bookId, input.chapterId, {
      offset: input.offset,
      maxChars: input.maxChars,
    });
  });
}
```

- [ ] **Step 6: 在 `src/main.ts` 注册**：import `registerLibraryHandlers`，ready 回调里 `registerAppHandlers();` 之后加 `registerLibraryHandlers();`。

- [ ] **Step 7: typecheck + 全量测试 + 提交**

```bash
pnpm typecheck
pnpm db:rebuild:node && pnpm test
git add -A
git commit -m "feat(ma2): content service (toc/text/summary) + library IPC handlers"
```

---

## Self-Review（计划自检）

- **Spec 覆盖**：MA2 对应 spec §14（导入解析 OPF/NCX→books+chapters、进度）、§8（getToc/readChapterText/getChapterSummary 底层；AI 工具包装在 MA4）、§5（books/chapters/progress 仓库）。章节摘要**生成**（懒队列）属 MA4；本里程碑 `getChapterSummary` 只读已存状态。
- **封装决策落实**：纯解析/文本提取在 `@marginalia/epub-parser`（无 DB/Electron/fs），DB 编排 + 读文件 + IPC 在 `src/main`。pnpm workspace 排除 ui-prototype。
- **并入 review defer 项**：`TocNode` 转为库类型 + `tocNodeSchema`（Zod），`getToc` 做 parse-on-read 校验。
- **占位符扫描**：无 TBD。node-html-parser 的 `:scope` 缺失已用 `parentNode` 过滤直接子节点处理，并注明"以测试为准"。
- **类型一致性**：库导出 `ParsedEpub/SpineItem/TocNode/ChapterTextSlice`；`shared/types` re-export `TocNode`；`shared/library` 的 schema ↔ handler 泛型 ↔ 仓库/服务签名一致；`DB` 注入贯穿仓库/服务。
- **依赖前置**：MA1 已合并 main；从 main 切 `feat/ma2-epub-content`。需 `pnpm install` 软链 workspace 包，跑 app 测试前 `pnpm db:rebuild:node`。
