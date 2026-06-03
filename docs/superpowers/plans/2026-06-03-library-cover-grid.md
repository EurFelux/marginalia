# 书库封面墙（Apple Books 风）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把书库改成 Apple Books 风纯封面墙——已存的 `books.cover` blob 经自定义协议 `cover://` 喂给 `<img>`，无封面的书用「截断书名+作者」生成确定性配色的兜底 tile。

**Architecture:** 主进程注册 privileged `cover://` 协议，handler 读 `books.cover` 返回图片 Response（按需、浏览器缓存懒加载）。纯逻辑（magic-bytes 嗅探 + 读字节）在不 import electron 的 `cover-bytes.ts`（headless 可测），协议注册胶水在 `cover-protocol.ts`（碰 electron，只被 `main.ts` 调）。`library:list` 加 `hasCover` 布尔且 `listBooks` 不再载 blob。渲染层 `BookCover` 组件渲染封面墙，兜底配色由确定性 hash 从 Tailwind 渐变调色板取。

**Tech Stack:** Electron 41（`protocol.handle` / `registerSchemesAsPrivileged`）、Drizzle（better-sqlite3）、React 19 + Tailwind、Vitest 4（Electron 运行时）。设计依据：`docs/superpowers/specs/2026-06-03-library-cover-grid-design.md`。

**关键约束（已取证）：**

- `pnpm test` 跑在 `ELECTRON_RUN_AS_NODE` 下，`require("electron")` 返回二进制路径字符串、`protocol` 为 undefined。**纯逻辑文件不得 import electron**；electron 调用只在函数内、只被 `main.ts` 调。
- `registerSchemesAsPrivileged` 必须在 `app.ready` 前（`main.ts` 模块顶层）；`protocol.handle` 在 ready 内、`initDb()` 后（handler 需 `getDb()`）。
- bookId 可能是 ePub uid（`urn:uuid:…`，含 `:`/`/`）→ URL 用固定 host `b` + `encodeURIComponent(bookId)` 放 path。
- `makeFixtureEpub()` 默认**带封面**（`parse.test.ts` 已验 `p.cover.byteLength>0`），可直接用于测「有封面」路径。

**与 #9 P3 协调（P3 在 `vast-greeting-scott` 并行、未合 main）：** 本计划只 **新增** `BookSummaryDto.hasCover`、**不删** `path`（P3 删 path——不同改动行，合并干净）。`toDto`/`listBooks`/`repository.ts` 的改动与 P3 在不同函数。详见 spec §6。

---

## File Structure

| 文件                                               | 责任                                                                      | Task |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| `src/main/library/cover-bytes.ts`（新）            | 纯逻辑：`sniffImageType` + `coverResponseFor`（注入 db，**无 electron**） | 1    |
| `src/main/library/cover-bytes.test.ts`（新）       | headless 单测                                                             | 1    |
| `src/main/library/cover-protocol.ts`（新）         | 胶水：注册 scheme + `protocol.handle`（碰 electron）                      | 2    |
| `src/main.ts`                                      | 顶层注册 scheme + ready 内 handle                                         | 2    |
| `src/main/library/repository.ts`                   | `listBooks` 加 `hasCover`、不载 blob                                      | 3    |
| `src/shared/library.ts`                            | `BookSummaryDto` 加 `hasCover`                                            | 3    |
| `src/main/ipc/library-handlers.ts`                 | `toDto` + 3 个调用点透传 `hasCover`                                       | 3    |
| `src/main/library/repository.test.ts`              | `listBooks` hasCover 测                                                   | 3    |
| `src/renderer/library/cover-palette.ts`（新）      | 纯逻辑：确定性配色 `coverGradientClass`                                   | 4    |
| `src/renderer/library/cover-palette.test.ts`（新） | headless 单测（类比 `epub-drop.test.ts`）                                 | 4    |
| `src/renderer/library/BookCover.tsx`（新）         | 封面 / 兜底 tile 组件（手测）                                             | 5    |
| `src/renderer/library/LibraryView.tsx`             | 列表项换成封面墙网格                                                      | 5    |

依赖序：1→2，3，4 各自独立，5 依赖 3+4（且运行期依赖 2）。按 1→2→3→4→5 执行。

---

## Task 1: 封面字节纯逻辑 `cover-bytes.ts`

**Files:**

- Create: `src/main/library/cover-bytes.ts`
- Test: `src/main/library/cover-bytes.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/main/library/cover-bytes.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { importBook } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { coverResponseFor, sniffImageType } from "@main/library/cover-bytes";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("sniffImageType", () => {
  it("detects jpeg/png/gif/webp by magic bytes; unknown → octet-stream", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(
      sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
  });
});

describe("coverResponseFor", () => {
  it("returns bytes + content-type for a book that has a cover", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub(), filePath: "/b.epub" });
    const r = coverResponseFor(db, book.id);
    expect(r).not.toBeNull();
    expect(r!.bytes.byteLength).toBeGreaterThan(0);
    expect(r!.contentType).toMatch(/^image\//);
  });

  it("returns null for a book with no cover", () => {
    const db = freshDb();
    db.insert(books).values({ id: "no-cover", path: "/x.epub", cover: null }).run();
    expect(coverResponseFor(db, "no-cover")).toBeNull();
  });

  it("returns null for an unknown book", () => {
    const db = freshDb();
    expect(coverResponseFor(db, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/cover-bytes.test.ts`
Expected: FAIL（`cover-bytes` 模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 `cover-bytes.ts`**

Create `src/main/library/cover-bytes.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";

/** 按 magic bytes 嗅探图片 content-type（epub-parser 只给封面字节、不给 MIME，故读时判）。 */
export function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

/** 读某书封面字节 + content-type（注入 db）。无此书 / 无封面 → null。`cover://` 协议 handler 用。 */
export function coverResponseFor(
  db: DB,
  bookId: string,
): { bytes: Uint8Array; contentType: string } | null {
  const row = db.select({ cover: books.cover }).from(books).where(eq(books.id, bookId)).get();
  if (!row?.cover) return null;
  const bytes = new Uint8Array(row.cover);
  return { bytes, contentType: sniffImageType(bytes) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/cover-bytes.test.ts`
Expected: PASS（全部用例）

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/main/library/cover-bytes.ts src/main/library/cover-bytes.test.ts
git commit -m "feat(library): add cover bytes reader + image-type sniff (#cover-grid)

cover-bytes.ts：coverResponseFor（注入 db 读 books.cover）+ sniffImageType
（magic bytes 判 jpeg/png/gif/webp）。纯函数、无 electron，headless 测。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 若 prek 钩子以「files were modified by this hook」中止，重新 `git add` 上述文件再执行同一 commit（第二次过）。

---

## Task 2: `cover://` 协议胶水 + `main.ts` 接线

**Files:**

- Create: `src/main/library/cover-protocol.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现 `cover-protocol.ts`**

Create `src/main/library/cover-protocol.ts`:

```ts
import { protocol } from "electron";
import { getDb } from "@main/db/instance";
import { coverResponseFor } from "@main/library/cover-bytes";

/** 注册 cover:// 为 privileged/secure scheme。必须在 app.ready 之前调用（main.ts 顶层）。 */
export function registerCoverProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "cover", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * 挂 cover:// handler：cover://b/<encodeURIComponent(bookId)> → 读 books.cover 返回图片。
 * 必须在 app.ready 内、initDb() 之后调用（handler 取 getDb()）。
 */
export function registerCoverProtocol(): void {
  protocol.handle("cover", (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    const hit = coverResponseFor(getDb(), id);
    if (!hit) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(hit.bytes), {
      headers: { "content-type": hit.contentType },
    });
  });
}
```

- [ ] **Step 2: `main.ts` 接线**

`src/main.ts`：在 import 区加入（与其他 `@main/...` import 同处）：

```ts
import { registerCoverProtocol, registerCoverProtocolScheme } from "@main/library/cover-protocol";
```

在模块顶层、`app.on("ready", ...)` **之前**（紧跟 `if (started) { app.quit(); }` 之后）加一行：

```ts
// cover:// 自定义协议：scheme 注册须在 app.ready 前。
registerCoverProtocolScheme();
```

在 `app.on("ready", () => {` 回调内、`initDb()` 成功之后（在 `registerAppHandlers()` 等注册前后皆可，须在 `initDb` 后）加：

```ts
registerCoverProtocol(); // cover:// handler 需 getDb()，故在 initDb 后
```

（放在现有 `registerAppHandlers();` 那一组调用旁即可。）

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误（`protocol`/`Response` 为 Electron/Web 全局类型）

Run: `pnpm test`
Expected: 全套 PASS（本任务不加测试，回归确认 cover-bytes 等未受影响；协议胶水不被 headless 测加载执行）

- [ ] **Step 4: 手动验证（运行期）**

Run: `pnpm start`
人工核对：导入一本有封面的 ePub（或已在库的书），打开书库——DevTools Network 应见 `cover://b/...` 请求 200 + `content-type: image/*`；封面正常显示。（此步在 Task 5 渲染层接好后才有可视效果；此处仅确认协议注册不报错、`pnpm start` 正常起。）

- [ ] **Step 5: 提交**

```bash
git add src/main/library/cover-protocol.ts src/main.ts
git commit -m "feat(library): register cover:// protocol serving books.cover (#cover-grid)

registerCoverProtocolScheme（app.ready 前 privileged/secure）+ registerCoverProtocol
（ready 内 protocol.handle 读 coverResponseFor 返回图片）。main.ts 接线。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `listBooks` 加 `hasCover`（不载 blob）+ DTO 接线

**Files:**

- Modify: `src/shared/library.ts`
- Modify: `src/main/library/repository.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/library/repository.test.ts`：导入区补 `books`（若未导入）；在 `describe("library repository", …)` 内末尾加：

```ts
it("listBooks derives hasCover and does not load the cover blob", () => {
  const db = freshDb();
  importBook(db, { bytes: makeFixtureEpub(), filePath: "/withcover.epub" }); // fixture 带封面
  db.insert(books).values({ id: "no-cover", path: "/x.epub", cover: null }).run();

  const items = listBooks(db);
  const withCover = items.find((b) => b.id !== "no-cover")!;
  const noCover = items.find((b) => b.id === "no-cover")!;

  expect(Boolean(withCover.hasCover)).toBe(true);
  expect(Boolean(noCover.hasCover)).toBe(false);
  // 不再把 blob 载进内存（listBooks 不选 cover 列）
  expect(withCover).not.toHaveProperty("cover");
});
```

（`books`、`importBook`、`listBooks`、`makeFixtureEpub` 已在该文件导入；若 `books` 未导入则加 `import { books } from "@main/db/schema";`——当前文件已 `import { chapters } from "@main/db/schema"`，改为 `import { books, chapters } from "@main/db/schema";`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL（`hasCover` 不存在 / 类型错误）

- [ ] **Step 3: 改 `listBooks`（repository.ts）**

`src/main/library/repository.ts`：第 2 行导入加 `sql`：

```ts
import { and, eq, sql } from "drizzle-orm";
```

`listBooks`（当前第 62–64 行）替换为：

```ts
export function listBooks(db: DB) {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      path: books.path,
      hasCover: sql<boolean>`${books.cover} is not null`,
    })
    .from(books)
    .all();
}
```

（去掉显式 `: BookRow[]` 返回标注——现返回窄行带 `hasCover`、不含 blob，让 drizzle 推断。）

- [ ] **Step 4: 改 `BookSummaryDto`（shared/library.ts）**

`src/shared/library.ts` 的 `BookSummaryDto`（当前第 24–29 行）加 `hasCover`（**保留 `path`**——P3 负责删它）：

```ts
export interface BookSummaryDto {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
  hasCover: boolean;
}
```

- [ ] **Step 5: 改 `toDto` 与 3 个调用点（library-handlers.ts）**

`src/main/ipc/library-handlers.ts` 的 `toDto`（当前第 32–42 行）替换为（入参加 `hasCover`，输出规范成 boolean）：

```ts
const toDto = (b: {
  id: string;
  title: string | null;
  author: string | null;
  path: string;
  hasCover: boolean;
}): BookSummaryDto => ({
  id: b.id,
  title: b.title,
  author: b.author,
  path: b.path,
  hasCover: Boolean(b.hasCover),
});
```

import handler（当前第 45–55 行）的返回改为先取 book 再补 `hasCover`：

```ts
const bytes = new Uint8Array(buf);
const book = importBook(getDb(), { bytes, filePath: input.filePath });
return toDto({ ...book, hasCover: book.cover != null });
```

list handler（当前第 67 行）不变（`listBooks` 现已带 `hasCover`）：

```ts
handle<void, BookSummaryDto[]>(IPC.libraryList, z.void(), () => listBooks(getDb()).map(toDto));
```

get handler（当前第 69–72 行）补 `hasCover`：

```ts
handle<{ bookId: string }, BookSummaryDto | null>(IPC.libraryGet, bookIdInput, (input) => {
  const b = getBook(getDb(), input.bookId);
  return b ? toDto({ ...b, hasCover: b.cover != null }) : null;
});
```

- [ ] **Step 6: 跑测试 + 类型检查**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: 无错误（`BookSummaryDto.hasCover` 由三个 toDto 调用点提供；`listBooks` 推断行含 `hasCover`）

- [ ] **Step 7: 提交**

```bash
git add src/shared/library.ts src/main/library/repository.ts src/main/ipc/library-handlers.ts src/main/library/repository.test.ts
git commit -m "feat(library): add hasCover to BookSummaryDto; listBooks stops loading blob (#cover-grid)

listBooks 改为 select 指定列 + sql 派生 hasCover（不再 select().all() 白载所有
封面 blob）；BookSummaryDto 加 hasCover；toDto 及 import/list/get 三处透传。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 兜底配色纯逻辑 `cover-palette.ts`

**Files:**

- Create: `src/renderer/library/cover-palette.ts`
- Test: `src/renderer/library/cover-palette.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/library/cover-palette.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COVER_GRADIENTS, coverGradientClass } from "./cover-palette";

describe("coverGradientClass", () => {
  it("is deterministic: same id → same class", () => {
    expect(coverGradientClass("urn:uuid:abc")).toBe(coverGradientClass("urn:uuid:abc"));
  });

  it("always returns a palette member", () => {
    for (const id of ["a", "book-1", "urn:uuid:xyz", "", "🐱"]) {
      expect(COVER_GRADIENTS).toContain(coverGradientClass(id));
    }
  });

  it("spreads across the palette (not all ids collapse to one class)", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `book-${i}`);
    const distinct = new Set(ids.map(coverGradientClass));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/library/cover-palette.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `cover-palette.ts`**

Create `src/renderer/library/cover-palette.ts`:

```ts
/**
 * 无封面兜底 tile 的渐变配色调色板。**字面量写死**这些类名供 Tailwind JIT 扫描生成
 * （配合 `bg-gradient-to-br ${coverGradientClass(id)}` 使用）。
 */
export const COVER_GRADIENTS = [
  "from-violet-500 to-violet-900",
  "from-rose-500 to-rose-900",
  "from-emerald-500 to-emerald-900",
  "from-sky-500 to-sky-900",
  "from-amber-500 to-amber-800",
  "from-fuchsia-500 to-fuchsia-900",
  "from-teal-500 to-teal-900",
  "from-indigo-500 to-indigo-900",
] as const;

/** 由 bookId 确定性派生一个调色板项（同书恒定、跨书多彩随机）。 */
export function coverGradientClass(bookId: string): string {
  let h = 0;
  for (let i = 0; i < bookId.length; i++) h = (h * 31 + bookId.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[h % COVER_GRADIENTS.length];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/library/cover-palette.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/library/cover-palette.ts src/renderer/library/cover-palette.test.ts
git commit -m "feat(library): add deterministic cover gradient palette (#cover-grid)

coverGradientClass(bookId)：从精选 Tailwind 渐变调色板按确定性字符串 hash 取，
同书恒定、跨书多彩——给无封面兜底 tile 用。纯函数、headless 测。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `BookCover` 组件 + `LibraryView` 封面墙

**Files:**

- Create: `src/renderer/library/BookCover.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`

- [ ] **Step 1: 实现 `BookCover.tsx`**

Create `src/renderer/library/BookCover.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { coverGradientClass } from "./cover-palette";

export function BookCover({ book, onOpen }: { book: BookSummaryDto; onOpen: () => void }) {
  const { t } = useTranslation();
  const title = book.title ?? book.id;
  const author = book.author ?? t("library.unknownAuthor", "未知作者");
  const label = `${title} · ${author}`;
  return (
    <button
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="block w-full overflow-hidden rounded-md shadow-md transition-transform hover:-translate-y-1 hover:shadow-xl"
    >
      {book.hasCover ? (
        <img
          src={`cover://b/${encodeURIComponent(book.id)}`}
          alt=""
          loading="lazy"
          className="aspect-[2/3] w-full object-cover"
        />
      ) : (
        <div
          className={`flex aspect-[2/3] w-full flex-col justify-between bg-gradient-to-br ${coverGradientClass(book.id)} p-3 text-white`}
        >
          <span className="line-clamp-4 font-serif text-base font-semibold">{title}</span>
          <span className="truncate text-xs text-white/80">{author}</span>
        </div>
      )}
    </button>
  );
}
```

（`alt=""`：封面为装饰，无障碍标签由 `<button aria-label>` 承载，避免重复朗读。）

- [ ] **Step 2: `LibraryView` 换成封面墙网格**

`src/renderer/library/LibraryView.tsx`：import 区加：

```ts
import { BookCover } from "./BookCover";
```

把 `<ul>` 列表（当前第 137–156 行）整体替换为：

```tsx
<ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-5">
  {books.data?.map((b) => (
    <li key={b.id}>
      <BookCover book={b} onOpen={() => openBook(b.id)} />
    </li>
  ))}
</ul>
```

（`BookOpen` 图标仍用于空态 `library.empty`，import 保留；行卡里的 `BookOpen` 占位随旧 `<ul>` 一并移除。）

- [ ] **Step 3: 类型检查 + lint**

Run: `pnpm typecheck`
Expected: 无错误

Run: `pnpm lint`
Expected: 无错误（无未用 import——确认 `BookOpen` 仍被空态使用、未残留行卡里的图标用法）

- [ ] **Step 4: 手动验证**

Run: `pnpm start`
人工核对：

- 书库呈**封面墙**：有封面的书显示封面图（`cover://` 200）；无封面的书显示**渐变兜底 tile**（截断书名 + 作者，配色按书不同）。
- 封面下**无文字标注**；hover 微抬 + 投影加深。
- 点封面正常开书。
- 长书名在兜底 tile 内截断（最多 4 行）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/library/BookCover.tsx src/renderer/library/LibraryView.tsx
git commit -m "feat(library): Apple Books-style cover wall (#cover-grid)

BookCover 组件：hasCover → <img src=cover://b/<id>>；否则按 coverGradientClass
派生配色的兜底 tile（截断书名+作者）。LibraryView 列表项换成无文字封面墙网格。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec 覆盖（对照设计 spec）：**

- DD-1 纯封面墙 + 兜底 tile（派生配色）→ Task 5（BookCover）+ Task 4（palette）。✅
- DD-2 `cover://` 协议读 blob → Task 1（coverResponseFor）+ Task 2（注册/handle）。✅
- DD-3 `hasCover` 驱动封面/兜底 → Task 3（DTO/listBooks）+ Task 5（分支渲染）。✅
- DD-4 listBooks 去 blob 载入 → Task 3 Step 3。✅
- DD-5 magic-bytes 嗅探 → Task 1（sniffImageType）。✅
- DD-6 确定性调色板 → Task 4。✅
- §4 CSP 无需改 → 计划未涉（无 CSP）。✅
- §6 P3 协调（只加 hasCover 不删 path）→ Task 3 Step 4 显式保留 `path`。✅

**2. 占位扫描：** 无 TBD/TODO；每步完整代码 + 精确行号锚点 + 具体命令与预期。Task 2/Task 5 为 electron 胶水/React 组件，按项目惯例手测（非占位——纯逻辑已在 Task 1/3/4 headless 覆盖）。✅

**3. 类型/命名一致性：** `coverResponseFor`/`sniffImageType`（Task 1 定义、Task 2 消费）、`registerCoverProtocolScheme`/`registerCoverProtocol`（Task 2 定义、main.ts 调用）、`hasCover`（Task 3 DTO/listBooks/toDto 一致）、`coverGradientClass`/`COVER_GRADIENTS`（Task 4 定义、Task 5 消费）、URL `cover://b/<encodeURIComponent(id)>`（Task 2 handler 解码 ↔ Task 5 编码一致）。✅

**4. 运行期约束：** 纯逻辑文件（cover-bytes/cover-palette）不 import electron → headless 测安全；electron 调用仅在 cover-protocol.ts 函数内、只 main.ts 调；scheme 注册在 ready 前、handle 在 initDb 后。✅
