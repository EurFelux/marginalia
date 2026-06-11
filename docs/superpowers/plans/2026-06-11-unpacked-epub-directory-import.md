# Unpacked EPUB Directory Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `libraryImport` 能导入「未打包的 EPUB 目录」（Apple Books 导出的 package、Calibre/Sigil 工作目录、手动解压等），在入口处打包成标准 EPUB zip 字节再走现有流程，不再撞 `EISDIR`。

**Architecture:** 新增纯函数模块 `src/main/library/import-source.ts`：`packEpubDir(dir)` 用 fflate 把解包目录打包成标准 zip（`mimetype` 居首不压缩），`readBookBytes(filePath)` 在导入入口按 `stat` 分支（文件→readFile、目录→packEpubDir、其它→报错）。`libraryImport` 仅把原 `readFile(...)` 换成 `readBookBytes(...)`，下游 `importBook`/`writeBookFile` 零改动。

**Tech Stack:** TypeScript（strict）、fflate（`zipSync`/`unzipSync`，已是直接依赖）、`@marginalia/epub-parser`（`makeFixtureEpub`/`parseEpub`）、vitest（headless，跑在 Electron 运行时）。

**Spec:** `docs/superpowers/specs/2026-06-11-unpacked-epub-directory-import-design.md`

---

## File Structure

| 文件                                     | 责任                                                                           | 动作   |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `src/main/library/import-source.ts`      | `packEpubDir` + `readBookBytes`；纯 fs+fflate，不引 Electron                   | Create |
| `src/main/library/import-source.test.ts` | headless 单测：打包往返 + mimetype 居首/不压缩 + 三类错误 + readBookBytes 分支 | Create |
| `src/main/ipc/library-handlers.ts`       | `libraryImport` 改用 `readBookBytes`；删除不再使用的 `readFile` import         | Modify |
| `.changeset/unpacked-epub-dir-import.md` | 用户向英文 changelog                                                           | Create |

**关键既有事实（实现据此）**

- `detectFormat`（`src/main/library/repository.ts:56`）魔数嗅探：`%PDF-`→pdf、`PK`→epub。`packEpubDir` 产出 `PK..` zip，天然判 epub，无需改它。
- `makeFixtureEpub(opts?: { title?; identifier?; coverViaMeta? })`（`@marginalia/epub-parser`）产出含 `mimetype`(stored) + `META-INF/container.xml` + `OEBPS/content.opf`(带 `<dc:title>`) 等条目的合法 EPUB 字节——测试用它「合法 zip → 摊成目录 → 再打包」做往返。
- `parseEpub(bytes): ParsedEpub`，字段 `title?: string`、`spine: SpineItem[]`、`uid`。
- `library-handlers.ts` 现状：`readFile` 仅在 `libraryImport`（行 72）用一次，改完即成 unused import，须删。

---

## Task 1: `packEpubDir` 打包目录（happy path）

**Files:**

- Create: `src/main/library/import-source.ts`
- Test: `src/main/library/import-source.test.ts`

- [ ] **Step 1: Write the failing test**

写入 `src/main/library/import-source.test.ts`：

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { makeFixtureEpub, parseEpub } from "@marginalia/epub-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFormat } from "@main/library/repository";
import { packEpubDir } from "@main/library/import-source";

/** 把一份合法 epub zip 摊成「未打包 EPUB 目录」落到 destDir。 */
async function explodeEpubToDir(zip: Uint8Array, destDir: string): Promise<void> {
  for (const [rel, bytes] of Object.entries(unzipSync(zip))) {
    const abs = path.join(destDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
}

describe("packEpubDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-epubdir-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("packs an unpacked EPUB directory into a parseable standard zip", async () => {
    const src = path.join(dir, "book.epub"); // 这是个目录
    await explodeEpubToDir(makeFixtureEpub({ title: "Roundtrip Title" }), src);

    const zip = packEpubDir(src);

    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(detectFormat(zip)).toBe("epub");
    expect(parseEpub(zip).title).toBe("Roundtrip Title");
  });

  it("writes mimetype as the first entry, stored (uncompressed)", async () => {
    const src = path.join(dir, "book.epub");
    await explodeEpubToDir(makeFixtureEpub(), src);

    const zip = packEpubDir(src);

    // 本地文件头：压缩方法在偏移 8（0 = stored）；文件名从偏移 30 起
    expect(zip[8]).toBe(0);
    expect(zip[9]).toBe(0);
    expect(new TextDecoder().decode(zip.subarray(30, 38))).toBe("mimetype");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: FAIL —— 解析 `@main/library/import-source` 报错（模块/`packEpubDir` 未定义）。

- [ ] **Step 3: Write minimal implementation**

写入 `src/main/library/import-source.ts`：

```ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";

/** 递归列出 root 下所有文件的相对路径（posix `/` 分隔），跳过点文件（.DS_Store 等）。 */
function listFilesRel(root: string): string[] {
  const walk = (abs: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) out.push(...walk(child));
      else out.push(path.relative(root, child).split(path.sep).join("/"));
    }
    return out;
  };
  return walk(root);
}

/** 把未打包的 EPUB 目录（OCF 解包形态）打包成标准 EPUB zip 字节；mimetype 居首且不压缩。 */
export function packEpubDir(dirPath: string): Uint8Array {
  const rels = listFilesRel(dirPath);
  const ordered = rels.includes("mimetype")
    ? ["mimetype", ...rels.filter((r) => r !== "mimetype")]
    : rels;

  const entries: Zippable = {};
  for (const rel of ordered) {
    const bytes = new Uint8Array(readFileSync(path.join(dirPath, rel)));
    entries[rel] = rel === "mimetype" ? [bytes, { level: 0 }] : bytes;
  }
  return zipSync(entries);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/import-source.ts src/main/library/import-source.test.ts
git commit -m "feat(library): pack unpacked EPUB directory into standard zip"
```

---

## Task 2: 拒绝非法目录（缺 `META-INF/container.xml`）

**Files:**

- Modify: `src/main/library/import-source.ts`
- Test: `src/main/library/import-source.test.ts`

- [ ] **Step 1: Write the failing test**

在 `import-source.test.ts` 的 `describe("packEpubDir", ...)` 内追加：

```ts
it("rejects a directory that is not a valid EPUB (no META-INF/container.xml)", async () => {
  const src = path.join(dir, "not-epub.epub");
  await mkdir(path.join(src, "OEBPS"), { recursive: true });
  await writeFile(path.join(src, "mimetype"), "application/epub+zip");
  await writeFile(path.join(src, "OEBPS", "x.xhtml"), "<html></html>");
  // 故意不写 META-INF/container.xml

  expect(() => packEpubDir(src)).toThrow(/Not a valid EPUB directory/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: FAIL —— 当前实现不校验，会照常打包返回，未抛错。

- [ ] **Step 3: Write minimal implementation**

在 `import-source.ts` 顶部 import 增加 `statSync`：

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
```

在 `packEpubDir` 函数体**最前面**插入守卫：

```ts
export function packEpubDir(dirPath: string): Uint8Array {
  const hasContainer = (() => {
    try {
      return statSync(path.join(dirPath, "META-INF", "container.xml")).isFile();
    } catch {
      return false;
    }
  })();
  if (!hasContainer) {
    throw new Error(`Not a valid EPUB directory (missing META-INF/container.xml): "${dirPath}"`);
  }

  const rels = listFilesRel(dirPath);
  // …（其余不变）
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/import-source.ts src/main/library/import-source.test.ts
git commit -m "feat(library): reject non-EPUB directories in packEpubDir"
```

---

## Task 3: 读失败健壮性（占位文件/ENOENT → 整体报错，不产半成品）

**Files:**

- Modify: `src/main/library/import-source.ts`
- Test: `src/main/library/import-source.test.ts`

- [ ] **Step 1: Write the failing test**

在 `import-source.test.ts` 顶部 import 增加 `symlink`：

```ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
```

在 `describe("packEpubDir", ...)` 内追加（断链 symlink 等价模拟 dataless 占位文件读不到）：

```ts
it("throws (no partial zip) when a directory entry cannot be read", async () => {
  const src = path.join(dir, "evicted.epub");
  await explodeEpubToDir(makeFixtureEpub(), src); // 合法目录，过 container 校验
  // 加一个指向不存在目标的断链 symlink —— readFileSync 会 ENOENT
  await symlink(path.join(dir, "nonexistent-target"), path.join(src, "OEBPS", "ghost.xhtml"));

  expect(() => packEpubDir(src)).toThrow(/Cannot read EPUB directory contents/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: FAIL —— 当前 `readFileSync` 直接抛裸 `ENOENT`，message 不含 `Cannot read EPUB directory contents`。

- [ ] **Step 3: Write minimal implementation**

把 `packEpubDir` 里的读字节那一行包进 try/catch：

```ts
const entries: Zippable = {};
for (const rel of ordered) {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path.join(dirPath, rel)));
  } catch {
    throw new Error(
      `Cannot read EPUB directory contents (a file may be a non-materialized iCloud/Apple Books placeholder; download it locally and retry): "${path.join(dirPath, rel)}"`,
    );
  }
  entries[rel] = rel === "mimetype" ? [bytes, { level: 0 }] : bytes;
}
return zipSync(entries);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/import-source.ts src/main/library/import-source.test.ts
git commit -m "feat(library): fail cleanly on unreadable EPUB directory entries"
```

---

## Task 4: `readBookBytes` 入口分支（文件 / 目录 / 其它）

**Files:**

- Modify: `src/main/library/import-source.ts`
- Test: `src/main/library/import-source.test.ts`

- [ ] **Step 1: Write the failing test**

在 `import-source.test.ts` 顶部 import 增加 `readBookBytes`：

```ts
import { packEpubDir, readBookBytes } from "@main/library/import-source";
```

在文件末尾追加新 `describe`：

```ts
describe("readBookBytes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-readbytes-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns raw bytes for a regular .epub file", async () => {
    const file = path.join(dir, "real.epub");
    await writeFile(file, makeFixtureEpub({ title: "File Path Book" }));

    const bytes = await readBookBytes(file);

    expect(parseEpub(bytes).title).toBe("File Path Book");
  });

  it("packs a directory via packEpubDir", async () => {
    const src = path.join(dir, "dir.epub");
    await explodeEpubToDir(makeFixtureEpub({ title: "Dir Book" }), src);

    const bytes = await readBookBytes(src);

    expect(detectFormat(bytes)).toBe("epub");
    expect(parseEpub(bytes).title).toBe("Dir Book");
  });

  it("throws a readable error for a missing path", async () => {
    await expect(readBookBytes(path.join(dir, "nope.epub"))).rejects.toThrow(
      /Cannot read book file/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: FAIL —— `readBookBytes` 未导出/未定义。

- [ ] **Step 3: Write minimal implementation**

在 `import-source.ts` 顶部 import 增加 `node:fs/promises`：

```ts
import { readFile, stat } from "node:fs/promises";
```

在文件末尾追加：

```ts
/** 导入入口取字节：普通文件→readFile；目录→当未打包 EPUB 打包；其它→报错。 */
export async function readBookBytes(filePath: string): Promise<Uint8Array> {
  let st;
  try {
    st = await stat(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(`Cannot read book file at "${filePath}": ${e.code ?? e.message}`);
  }
  if (st.isDirectory()) return packEpubDir(filePath);
  if (st.isFile()) {
    const buf = await readFile(filePath).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`Cannot read book file at "${filePath}": ${err.code ?? err.message}`);
    });
    return new Uint8Array(buf);
  }
  throw new Error(`Cannot read book file at "${filePath}": not a regular file or directory`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/library/import-source.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/import-source.ts src/main/library/import-source.test.ts
git commit -m "feat(library): add readBookBytes import-source entry helper"
```

---

## Task 5: 接入 `libraryImport` 入口

**Files:**

- Modify: `src/main/ipc/library-handlers.ts`（import 区 + `libraryImport` 绑定）

- [ ] **Step 1: 替换导入入口的读取逻辑**

把 `libraryImport` 绑定（约行 71-80）由：

```ts
  bind(C.libraryImport, async (input) => {
    const buf = await readFile(input.filePath).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`Cannot read book file at "${input.filePath}": ${err.code ?? err.message}`);
    });
    const bytes = new Uint8Array(buf);
    const book = await importBook(getDb(), { bytes, fileName: path.basename(input.filePath) });
    await writeBookFile(appService.getPath("booksDir"), book.id, book.format, bytes); // 复制进 app 自有位置（relink/重导即覆盖）
    log.info(`book imported: ${book.id} (${book.format}, ${Math.round(bytes.length / 1024)}KB)`);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),
```

改为：

```ts
  bind(C.libraryImport, async (input) => {
    const bytes = await readBookBytes(input.filePath);
    const book = await importBook(getDb(), { bytes, fileName: path.basename(input.filePath) });
    await writeBookFile(appService.getPath("booksDir"), book.id, book.format, bytes); // 复制进 app 自有位置（relink/重导即覆盖）
    log.info(`book imported: ${book.id} (${book.format}, ${Math.round(bytes.length / 1024)}KB)`);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),
```

- [ ] **Step 2: 修正 import 区**

删除已不再使用的：

```ts
import { readFile } from "node:fs/promises";
```

在 `import { readBookFile, writeBookFile } from "@main/library/book-files";` 一行**下方**新增：

```ts
import { readBookBytes } from "@main/library/import-source";
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 无错；全部测试 PASS（含新 `import-source.test.ts`，既有用例零回归）。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/library-handlers.ts
git commit -m "feat(library): import unpacked EPUB directories via readBookBytes"
```

---

## Task 6: changeset + 最终验证

**Files:**

- Create: `.changeset/unpacked-epub-dir-import.md`

- [ ] **Step 1: 写 changeset（用户向英文 changelog）**

写入 `.changeset/unpacked-epub-dir-import.md`：

```md
---
"marginalia": patch
---

Import EPUB books that are unpacked directories instead of zip files (for example, books exported from Apple Books, or epubs unzipped by Calibre/Sigil). These previously failed to import with an `EISDIR` error; they are now packed into a standard EPUB on import. Directories that aren't valid EPUBs, or whose contents can't be read (e.g. not-yet-downloaded iCloud placeholders), now report a clear, actionable error.
```

- [ ] **Step 2: 最终全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三者全绿。

- [ ] **Step 3: Commit**

```bash
git add .changeset/unpacked-epub-dir-import.md
git commit -m "chore: add changeset for unpacked EPUB directory import"
```

---

## Self-Review（写完计划后自查，已执行）

- **Spec coverage**：§4 数据流（readBookBytes 分支）→ Task 4/5；packEpubDir（mimetype 居首/不压缩、递归收集）→ Task 1；§5 三类错误——普通文件读失败 → Task 4（保留原 message）+ Task 5（入口复用）、缺 container.xml → Task 2、内容读不到 → Task 3；§6 文件清单 → Task 1/4/5 文件一一对应；§7 测试（mkdtemp 真实临时目录、断链 symlink 模拟 dataless）→ Task 1-4 测试；§8 验收（不产残缺书行 → Task 3；零回归 → Task 5 全量；typecheck/test 绿 → Task 6）。无遗漏。
- **Placeholder scan**：无 TBD/TODO；每个 code step 均给出完整代码与确切命令/预期。
- **Type consistency**：`packEpubDir(dirPath: string): Uint8Array`、`readBookBytes(filePath: string): Promise<Uint8Array>`、`listFilesRel(root: string): string[]` 全程一致；测试引用 `parseEpub(...).title`、`detectFormat(...)` 与既有类型/导出吻合；fflate `Zippable` / `[bytes, { level: 0 }]` 用法与 epub-parser 既有测试一致。
- **手动冒烟（非阻塞）**：IPC handler 触及 Electron（`appService`/`getDb`），无 headless 测试；其逻辑由 `readBookBytes` 单测覆盖，整体行为可在 `pnpm start` 后拖入一个 Apple Books 导出的 `.epub`（内容已 materialize）验证「成功导入并能开书读正文」。
