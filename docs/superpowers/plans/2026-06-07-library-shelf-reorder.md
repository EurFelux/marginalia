# 继续阅读书架 + 手动拖拽排序 + reader 进度显示 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 issue #48——书库网格上方的「继续阅读」信息卡书架（最多 3 本）、主网格 dnd-kit 手动拖拽排序、reader header 面包屑阅读进度显示。

**Architecture:** `progress` 表加 `percent`（0–1 real + DB CHECK）作「展示快照」，reader 保存进度时顺手上送；shelf 数据 = `books JOIN progress ORDER BY updatedAt DESC LIMIT 3`；`books.position` 承载手动排序，`library:reorder` IPC 全量重写。Spec：`docs/superpowers/specs/2026-06-07-library-shelf-reorder-design.md`。

**Tech Stack:** Drizzle ORM 1.0-rc3 + better-sqlite3、Zod 4、React 19（React Compiler 已启用——**勿手写 useCallback/useMemo**）、@tanstack/react-query、dnd-kit、vitest 4（跑在 Electron 运行时）。

**两处 spec 实现微调**（效果等同，已在计划层面定案）：

1. **position 初始化不用 ROW_NUMBER 数据回填**：`position INTEGER NOT NULL DEFAULT 0` + `listBooks` 用 `ORDER BY position ASC, added_at ASC`——既有书 position 全 0 时按 added_at 平断（= 导入序，与 ROW_NUMBER 回填同效），首次拖拽全量重写后 position 唯一。避免手工编辑 drizzle 迁移文件。
2. **percent 不进 `ReadingContext`**：那是 AI 聊天契约（`@shared/chat` 的 discriminated union，发主进程构建 prompt），UI 进度状态放 `navigation-store` 独立字段 `readingPercent`。PDF 面包屑的 `page / pageCount` 仍从 readingContext 读（pdf 分支已有这两字段）。

**通用约束（每个 task 都适用）：**

- 提交信息用 Conventional Commits；pre-commit hook（prek）可能改文件后中止——重新 `git add` 再跑同一 commit 命令即可。
- 日志规范：渲染层 `import { createLogger } from "@renderer/logger"`，主进程 `@main/logger`；消息不带前缀/尾冒号，Error 作第二参。
- 样式规范：优先 Tailwind 类；内联 style 仅限运行时计算值（dnd transform、进度条宽度）。
- i18n：`t("key", "中文默认值")` 形式；新 key 交付前跑 `pnpm i18n:extract`（在 typecheck **之前**跑）。
- 每个 task 结束跑 `pnpm test`（全量）确认绿再 commit。

---

### Task 1: DB schema——progress.percent（CHECK）+ books.position

**Files:**

- Modify: `src/main/db/schema.ts`（books 表 ~L52-75、progress 表 ~L94-102）
- Generate: `src/main/db/migrations/<timestamp>_<name>/`（drizzle-kit 产出，勿手编）

- [ ] **Step 1: 修改 schema**

`src/main/db/schema.ts` 首行 import 加 `real`：

```ts
import {
  blob,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
```

books 表 `addedAt` 字段后加（`(t) => [...]` 约束数组不动）：

```ts
    // 手动排序位（#48）：默认 0；listBooks 按 (position, added_at) 排——既有书全 0 时按导入序平断，
    // 首次拖拽全量重写后 position 唯一。新导入 = MIN(position) - 1（排最前）。无唯一约束：
    // 重复 position 以 rowid 平断，下次拖拽自愈（spec §3）。
    position: integer("position").notNull().default(0),
```

progress 表改为带约束数组的形式（当前无第二参；percent 列加在 locator 后）：

```ts
export const progress = sqliteTable(
  "progress",
  {
    bookId: text("book_id")
      .primaryKey()
      .references(() => books.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    // 0–1 阅读进度「展示快照」（#48）：reader 保存进度时顺手上送（locator 黑盒保持，主进程不解析）。
    // 老数据 null → shelf 卡不渲染进度行，读一次书即回填。
    percent: real("percent"),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    check(
      "progress_percent_check",
      sql`${t.percent} is null or (${t.percent} >= 0 and ${t.percent} <= 1)`,
    ),
  ],
);
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新增 `src/main/db/migrations/<timestamp>_<name>/` 目录（含 `migration.sql` + `snapshot.json`）。

- [ ] **Step 3: 审查产出 SQL**

Read 生成的 `migration.sql`。预期形态（与既有 `20260606145055_stiff_spitfire` 先例同型）：

- `ALTER TABLE books ADD position integer DEFAULT 0 NOT NULL`（简单加列）；
- progress 因表级 CHECK 走**表重建**（`PRAGMA foreign_keys=OFF` → `__new_progress` → INSERT SELECT → DROP/RENAME → `PRAGMA foreign_keys=ON`）。重建安全：无表反向引用 progress，且 `runMigrations` 在事务外切 FK（基建已有）。

若产出含意料外的 DROP（丢数据风险），停下报告，勿继续。

- [ ] **Step 4: 全量测试验证迁移可执行**

Run: `pnpm test`
Expected: 全绿（每个测试 setup 都跑 runMigrations，迁移坏会整片红）。

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations/
git commit -m "feat(db): add progress.percent (0-1 check) and books.position for #48"
```

---

### Task 2: saveProgress 带 percent（TDD）

**Files:**

- Modify: `src/main/library/progress.ts`
- Test: `src/main/library/progress.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/library/progress.test.ts` 的 describe 内追加：

```ts
it("saves percent and overwrites it on update (null when omitted)", async () => {
  const { db, book } = await setup();
  saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 0.25);
  expect(getProgress(db, book.id)?.percent).toBe(0.25);
  saveProgress(db, book.id, "epubcfi(/6/4!/4/1:0)", 0.5);
  expect(getProgress(db, book.id)?.percent).toBe(0.5);
  // 不带 percent 的保存把旧值抹成 null——locator 与 percent 是同一位置的快照，留旧值即脏数据
  saveProgress(db, book.id, "epubcfi(/6/6!/4/1:0)");
  expect(getProgress(db, book.id)?.percent).toBeNull();
});

it("rejects out-of-range percent via DB CHECK", async () => {
  const { db, book } = await setup();
  expect(() => saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", 1.5)).toThrow(/check/i);
  expect(() => saveProgress(db, book.id, "epubcfi(/6/2!/4/1:0)", -0.1)).toThrow(/check/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/progress.test.ts`
Expected: FAIL——saveProgress 不接受第 4 参（TS 报错或 percent 列恒 null）。

- [ ] **Step 3: 实现**

`src/main/library/progress.ts` 的 saveProgress 改为：

```ts
export function saveProgress(
  db: DB,
  bookId: string,
  locator: string,
  percent?: number | null,
): void {
  // percent 未传时写 null（而非保留旧值）：locator 与 percent 是同一位置的快照，半更新即脏数据。
  db.insert(progress)
    .values({ bookId, locator, percent: percent ?? null, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: progress.bookId,
      set: { locator, percent: percent ?? null, updatedAt: Date.now() },
    })
    .run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/progress.test.ts`
Expected: PASS（含既有 2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/progress.ts src/main/library/progress.test.ts
git commit -m "feat(main): save reading percent snapshot with progress"
```

---

### Task 3: repository——排序、recently-read、reorder、导入排最前（TDD）

**Files:**

- Modify: `src/main/library/repository.ts`
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/library/repository.test.ts` 文件尾追加（import 区补 `listRecentlyRead, reorderBooks` 到既有 repository import；`progress` 已在 schema import 里；`saveProgress` 从 `@main/library/progress` 引入；`sql` 不需要）：

```ts
// 裸插书行（绕过 importBook 的 fixture 同 bytes→同 id 幂等限制；只测排序/查询无需完整导入）。
const seedBook = (db: ReturnType<typeof createDb>, id: string, position = 0) => {
  db.insert(books).values({ id, title: id, position }).run();
};

describe("listBooks ordering (#48)", () => {
  it("orders by position, then added_at for ties", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    seedBook(db, "a"); // position 全 0 → added_at（插入序）平断
    seedBook(db, "b");
    seedBook(db, "c", -1); // 模拟新导入排最前
    expect(listBooks(db).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });
});

describe("listRecentlyRead (#48)", () => {
  const setupRead = () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    for (const id of ["a", "b", "c", "d"]) seedBook(db, id);
    return db;
  };
  const touch = (db: ReturnType<typeof createDb>, id: string, at: number, percent?: number) => {
    saveProgress(db, id, "epubcfi(/6/2!/4/1:0)", percent);
    db.update(progress).set({ updatedAt: at }).where(eq(progress.bookId, id)).run();
  };

  it("returns only read books, most recent first", () => {
    const db = setupRead();
    touch(db, "a", 1000);
    touch(db, "b", 3000);
    expect(listRecentlyRead(db).map((r) => r.id)).toEqual(["b", "a"]); // d/c 未读不出现
  });

  it("caps at limit 3 and carries percent + lastReadAt", () => {
    const db = setupRead();
    touch(db, "a", 1000, 0.1);
    touch(db, "b", 2000); // percent 未传 → null
    touch(db, "c", 3000, 0.5);
    touch(db, "d", 4000, 0.9);
    const r = listRecentlyRead(db);
    expect(r.map((x) => x.id)).toEqual(["d", "c", "b"]);
    expect(r[0]).toMatchObject({ percent: 0.9, lastReadAt: 4000 });
    expect(r[2]!.percent).toBeNull();
  });
});

describe("reorderBooks (#48)", () => {
  it("rewrites positions so listBooks follows the given order", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    for (const id of ["a", "b", "c"]) seedBook(db, id);
    reorderBooks(db, ["c", "a", "b"]);
    expect(listBooks(db).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });
});

describe("import position (#48)", () => {
  it("new imports land before existing books (MIN - 1; 0 on empty library)", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const epub = await importBook(db, { bytes: makeFixtureEpub() }); // 空库 → 0
    const pdf = await importBook(db, { bytes: makeTextPdf() }); // → -1，排最前
    expect(listBooks(db).map((b) => b.id)).toEqual([pdf.id, epub.id]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL——`listRecentlyRead`/`reorderBooks` 未导出、排序未实现。

- [ ] **Step 3: 实现**

`src/main/library/repository.ts`：

import 区：`drizzle-orm` 的 import 补 `asc, desc`（`eq, sql` 已有则保留）；schema import 补 `progress`。

```ts
/** 「继续阅读」shelf 容量（spec §4）。 */
export const RECENT_SHELF_LIMIT = 3;
```

`listBooks` 加排序（select 投影不变）：

```ts
    .from(books)
    .orderBy(asc(books.position), asc(books.addedAt))
    .all();
```

`listBooks` 后新增两个函数：

```ts
/**
 * 「继续阅读」shelf 数据（#48）：JOIN progress 按最近阅读排序。未读过的书（无 progress 行）
 * 天然不出现；percent 为 null（老数据）由渲染层降级。不解析 locator——黑盒保持。
 */
export function listRecentlyRead(db: DB, limit = RECENT_SHELF_LIMIT) {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      hasCover: sql<boolean>`${books.cover} is not null and length(${books.cover}) > 0`,
      format: books.format,
      pageCount: books.pageCount,
      hasTextLayer: books.hasTextLayer,
      percent: progress.percent,
      lastReadAt: progress.updatedAt,
    })
    .from(books)
    .innerJoin(progress, eq(progress.bookId, books.id))
    .orderBy(desc(progress.updatedAt))
    .limit(limit)
    .all();
}

/** 手动排序全量重写（#48）：position = orderedIds 下标。未知 id 的 UPDATE 是 no-op，无害。 */
export function reorderBooks(db: DB, orderedIds: string[]): void {
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(books).set({ position: index }).where(eq(books.id, id)).run();
    });
  });
}
```

两处导入 insert（`importEpubBook` 与 `importPdfBook` 的 `tx.insert(books).values({...})`）都加：

```ts
        // 新导入排最前（spec §3）：自引用标量子查询，空库 coalesce(NULL,1)-1 = 0。
        position: sql`(coalesce((select min(position) from books), 1) - 1)`,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS（含既有全部用例——若既有用例对 listBooks 顺序有假设需检查是否仍成立）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/repository.ts src/main/library/repository.test.ts
git commit -m "feat(main): recently-read query, manual reorder, import-to-front"
```

---

### Task 4: IPC 契约 + handlers + preload（必须同 commit——bindings-coverage 是双向相等断言）

**Files:**

- Modify: `src/shared/library.ts`、`src/shared/ipc.ts`（library 段 ~L110-120）
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/preload-api.ts`（library 段 ~L40-49）

- [ ] **Step 1: shared 契约**

`src/shared/library.ts`——`saveProgressInput` 改为：

```ts
export const saveProgressInput = z.object({
  bookId: z.string().min(1),
  locator: z.string().min(1),
  /** 0–1 阅读进度快照；reader 计算上送（spec 2026-06-07-library-shelf-reorder §4）。 */
  percent: z.number().min(0).max(1).nullish(),
});
```

`BookSummaryDto` 之后追加：

```ts
export const reorderBooksInput = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderBooksInput = z.infer<typeof reorderBooksInput>;

/** 「继续阅读」shelf 条目（#48）：书摘要 + 进度快照。 */
export interface RecentlyReadDto extends BookSummaryDto {
  percent: number | null; // 0–1；老数据 null → 卡片不渲染进度行
  lastReadAt: number; // = progress.updatedAt
}
```

`src/shared/ipc.ts`——`@shared/library` import 补 `reorderBooksInput` 与 `type RecentlyReadDto`；library 段 `libraryDelete` 后加：

```ts
  libraryRecentlyRead: def("library:recently-read", "invoke", z.void(), out<RecentlyReadDto[]>()),
  libraryReorder: def("library:reorder", "invoke", reorderBooksInput, out<void>()),
```

- [ ] **Step 2: handlers**

`src/main/ipc/library-handlers.ts`——repository import 补 `listRecentlyRead, reorderBooks`；`bind(C.libraryDelete, ...)` 后加：

```ts
  // shelf 数据：toDto 复用保证 hasCover 布尔化等口径一致，percent/lastReadAt 原样透传。
  bind(C.libraryRecentlyRead, () =>
    listRecentlyRead(getDb()).map((r) => ({
      ...toDto(r),
      percent: r.percent,
      lastReadAt: r.lastReadAt,
    })),
  ),

  bind(C.libraryReorder, (input) => reorderBooks(getDb(), input.orderedIds)),
```

`bind(C.progressSave, ...)` 内 `saveProgress` 调用改为：

```ts
saveProgress(db, input.bookId, input.locator, input.percent);
```

- [ ] **Step 3: preload**

`src/preload-api.ts` library 段（`delete:` 之后、`pathForFile` 注释之前）加：

```ts
      recentlyRead: inv(C.libraryRecentlyRead),
      reorder: inv(C.libraryReorder),
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test src/main/ipc/`
Expected: typecheck 绿；bindings-coverage 测试绿（双向相等：新通道有且仅有一个 binding）。

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/shared/library.ts src/shared/ipc.ts src/main/ipc/library-handlers.ts src/preload-api.ts
git commit -m "feat(ipc): library recently-read + reorder channels, progress percent input"
```

---

### Task 5: 安装 dnd-kit

**Files:**

- Modify: `package.json`、`pnpm-lock.yaml`

- [ ] **Step 1: 安装**

Run: `pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
Expected: 安装成功。注意输出尾部 postinstall 跑了 `db:rebuild:electron`（pnpm install 会把 better-sqlite3 重编为系统 Node ABI，postinstall 自动翻回 Electron ABI——这是预期机制，勿手动干预）。

- [ ] **Step 2: 验证 ABI 与依赖完好**

Run: `pnpm test`
Expected: 全绿（better-sqlite3 ABI 若坏会整片崩——postinstall 异常未跑时手动补 `pnpm db:rebuild:electron`）。

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(renderer): add dnd-kit for library grid reordering"
```

---

### Task 6: 渲染层 percent 纯函数（TDD）

**Files:**

- Create: `src/renderer/reader/percent.ts`
- Test: `src/renderer/reader/percent.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/reader/percent.test.ts`（新文件）：

```ts
import { describe, expect, it } from "vitest";
import { epubPercent, pdfPercent } from "./percent";

describe("epubPercent", () => {
  it("interpolates spine index + in-section ratio", () => {
    expect(epubPercent(0, 0, 10)).toBe(0);
    expect(epubPercent(5, 0.5, 10)).toBe(0.55);
    expect(epubPercent(9, 1, 10)).toBe(1);
  });
  it("clamps degenerate inputs", () => {
    expect(epubPercent(0, 0, 0)).toBe(0); // sectionCount 0 防除零
    expect(epubPercent(12, 0.5, 10)).toBe(1); // 越界收敛
    expect(epubPercent(0, -0.5, 10)).toBe(0);
  });
});

describe("pdfPercent", () => {
  it("is page / pageCount", () => {
    expect(pdfPercent(1, 4)).toBe(0.25);
    expect(pdfPercent(304, 304)).toBe(1);
  });
  it("clamps degenerate inputs", () => {
    expect(pdfPercent(1, 0)).toBe(0); // pageCount 0 防除零
    expect(pdfPercent(5, 4)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/percent.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/renderer/reader/percent.ts`（新文件）：

```ts
/** 阅读进度计算（#48）：reader 上送 progress.percent 与 header 进度显示共用（一份计算两处消费）。 */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** epub：spine 比例近似（epub-book 的 textLengths 惰性填充，字符加权不可行；spec §6.3）。 */
export function epubPercent(index: number, scrollRatio: number, sectionCount: number): number {
  if (sectionCount <= 0) return 0;
  return clamp01((index + clamp01(scrollRatio)) / sectionCount);
}

/** PDF：页比例，精确。 */
export function pdfPercent(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return clamp01(page / pageCount);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/percent.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/percent.ts src/renderer/reader/percent.test.ts
git commit -m "feat(renderer): reading percent pure functions"
```

---

### Task 7: reader 进度——store、两 reader 上送、面包屑显示

**Files:**

- Modify: `src/renderer/store/navigation-store.ts`
- Modify: `src/renderer/reader/EpubReader.tsx`（onTopSectionChange ~L140-177）
- Modify: `src/renderer/reader/PdfReader.tsx`（rangeChanged ~L280-310、saveAt ~L218-227）
- Modify: `src/renderer/reader/ReaderView.tsx`（面包屑 ~L89-91）

- [ ] **Step 1: navigation-store 加 readingPercent**

`NavigationState` 加字段、`NavigationActions` 加 action、`NAVIGATION_INITIAL` 加初值、store 实现加 setter，`openBook` 的 set 里重置：

```ts
interface NavigationState {
  view: "library" | "reader";
  currentBookId: string | null;
  currentChapterId: string | null;
  readingContext: ReadingContext | null;
  /** 0–1 阅读进度（header 面包屑显示用；#48）。与 readingContext 分离——后者是 AI 聊天契约。 */
  readingPercent: number | null;
}
interface NavigationActions {
  openBook: (bookId: string, chapterId?: string | null) => void;
  backToLibrary: () => void;
  setCurrentChapter: (chapterId: string) => void;
  setReadingContext: (readingContext: ReadingContext | null) => void;
  setReadingPercent: (readingPercent: number | null) => void;
}

export const NAVIGATION_INITIAL: NavigationState = {
  view: "library",
  currentBookId: null,
  currentChapterId: null,
  readingContext: null,
  readingPercent: null,
};
```

store 实现：`openBook` 的 `set({...})` 对象里加 `readingPercent: null,`；`setReadingContext` 行后加：

```ts
  setReadingPercent: (readingPercent) => set({ readingPercent }),
```

- [ ] **Step 2: EpubReader 上送**

import 加 `import { epubPercent } from "./percent";`；组件内取 setter（与既有 `setReadingContext` 相邻处）：

```ts
const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
```

`onTopSectionChange` 内、`if (!book) return;` 之后加：

```ts
const percent = epubPercent(index, meta.scrollRatio, book.count);
setReadingPercent(percent);
```

防抖保存处 `save({ bookId, locator: cfi })` 改为：

```ts
          .save({ bookId, locator: cfi, percent })
```

（防抖闭包捕获当次 percent 值，正确——保存的 locator 与 percent 同源于同一次回调。`qc.setQueryData(qk.progress(bookId), { locator: cfi })` 不变：progressGet 输出形状未扩。）

- [ ] **Step 3: PdfReader 上送**

import 加 `import { pdfPercent } from "./percent";`；组件内取 setter：

```ts
const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
```

`saveAt` 改签名并带 percent：

```ts
const saveAt = (page: number, percent: number) => {
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = setTimeout(() => {
    const locator = makePdfLocator({ page, scrollRatio: 0 }); // 页级精度（页内比例留打磨期）
    void window.api.progress
      .save({ bookId, locator, percent })
      .catch((err: unknown) => log.warn("save progress failed", err));
    qc.setQueryData(qk.progress(bookId), { locator });
  }, SAVE_DEBOUNCE_MS);
};
```

rangeChanged 回调内、`setReadingContext({...})` 之后加（首发也设置——进度显示从开书即正确，与 readingContext 同步；只是首发不写库）：

```ts
setReadingPercent(pdfPercent(page, book.pageCount));
```

末尾 `saveAt(page)` 改为：

```ts
saveAt(page, pdfPercent(page, book.pageCount));
```

- [ ] **Step 4: ReaderView 面包屑**

`src/renderer/reader/ReaderView.tsx` 面包屑区（~L89-91）改为：

```tsx
// 顶栏面包屑「书名 · 章节名 · 进度」：任一缺失只显示有的部分。进度：epub 纯百分比；
// PDF 带页码（page/pageCount 从 readingContext 读——pdf 分支已有，percent 走独立 store 字段）。
const chapterTitle = chapters.data?.find((c) => c.id === chapterId)?.title ?? null;
const readingPercent = useNavigationStore((s) => s.readingPercent);
const readingContext = useNavigationStore((s) => s.readingContext);
const progressLabel = (() => {
  if (readingPercent == null) return null;
  const pct = `${Math.round(readingPercent * 100)}%`;
  return readingContext?.format === "pdf" && readingContext.pageCount != null
    ? `${readingContext.page} / ${readingContext.pageCount} · ${pct}`
    : pct;
})();
const breadcrumb = [book.data?.title, chapterTitle, progressLabel].filter(Boolean).join(" · ");
```

（`useNavigationStore` 的 import 与 hook 调用模式照文件内既有用法；React Compiler 在岗，不需要 useMemo。）

- [ ] **Step 5: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。

Run: `pnpm lint`
Expected: 无新告警。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/navigation-store.ts src/renderer/reader/EpubReader.tsx src/renderer/reader/PdfReader.tsx src/renderer/reader/ReaderView.tsx
git commit -m "feat(renderer): reading progress in header breadcrumb, percent persisted with progress"
```

---

### Task 8: CoverImage 抽取（纯重构）

**Files:**

- Create: `src/renderer/library/CoverImage.tsx`
- Modify: `src/renderer/library/BookCover.tsx`（封面渲染块 L47-61）

- [ ] **Step 1: 新建 CoverImage**

`src/renderer/library/CoverImage.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { coverGradientClass } from "./cover-palette";

/**
 * 封面图块（从 BookCover 抽出，shelf 卡共用；#48）：有封面走 cover:// 协议，无封面渐变 tile。
 * withText=false 供小尺寸场景（shelf 缩略图）——渐变 tile 上的书名/作者在小宽度下不可读，只留色块。
 */
export function CoverImage({
  book,
  withText = true,
}: {
  book: BookSummaryDto;
  withText?: boolean;
}) {
  const { t } = useTranslation();
  if (book.hasCover) {
    return (
      <img
        src={`cover://b/${encodeURIComponent(book.id)}`}
        alt=""
        loading="lazy"
        className="aspect-[2/3] w-full object-cover"
      />
    );
  }
  const title = book.title ?? book.id;
  const author = book.author ?? t("library.unknownAuthor", "未知作者");
  return (
    <div
      className={`flex aspect-[2/3] w-full flex-col justify-between bg-gradient-to-br ${coverGradientClass(book.id)} p-3 text-white`}
    >
      {withText && (
        <>
          <span className="line-clamp-4 font-serif text-base font-semibold">{title}</span>
          <span className="truncate text-xs text-white/80">{author}</span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: BookCover 改用**

`src/renderer/library/BookCover.tsx`：删除 `coverGradientClass` import，加 `import { CoverImage } from "./CoverImage";`，把 `ContextMenuTrigger` 子树里的整个 `{book.hasCover ? <img .../> : <div ...>...</div>}` 块替换为：

```tsx
<CoverImage book={book} />
```

（`title`/`author` 局部变量仍被 `label` 使用，保留。）

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿（纯重构，UI 不变）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/library/CoverImage.tsx src/renderer/library/BookCover.tsx
git commit -m "refactor(renderer): extract CoverImage from BookCover for shelf reuse"
```

---

### Task 9: RecentlyReadShelf 组件 + LibraryView 接入

**Files:**

- Modify: `src/renderer/query/keys.ts`
- Create: `src/renderer/library/RecentlyReadShelf.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`（main 区 ~L148-176）

- [ ] **Step 1: query key**

`src/renderer/query/keys.ts` 的 qk 对象加：

```ts
  recentlyRead: ["recently-read"] as const,
```

- [ ] **Step 2: 新建 RecentlyReadShelf**

`src/renderer/library/RecentlyReadShelf.tsx`：

```tsx
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { createLogger } from "@renderer/logger";
import { CoverImage } from "./CoverImage";

const log = createLogger("library");

/**
 * 「继续阅读」shelf（#48 spec §6.1）：最近读过的 ≤3 本，信息卡带进度。
 * 无阅读记录（或查询失败）整个隐藏；staleTime 0——读完书返回时重挂载即 refetch。
 * shelf 是视图不是分区：同一本书同时出现在 shelf 与下方网格属预期。
 */
export function RecentlyReadShelf({ onOpen }: { onOpen: (bookId: string) => void }) {
  const { t } = useTranslation();
  const recent = useQuery({
    queryKey: qk.recentlyRead,
    queryFn: () => window.api.library.recentlyRead(),
    staleTime: 0,
  });

  // 查询失败 → 隐藏 + warn（优雅吞错必须留 warn）。
  useEffect(() => {
    if (recent.error) log.warn("recently read query failed", recent.error);
  }, [recent.error]);

  if (!recent.data?.length) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("library.continueReading", "继续阅读")}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recent.data.map((b) => (
          <li key={b.id}>
            <button
              onClick={() => onOpen(b.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="w-12 shrink-0 overflow-hidden rounded">
                <CoverImage book={b} withText={false} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-sm font-semibold">{b.title ?? b.id}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {b.author ?? t("library.unknownAuthor", "未知作者")}
                </p>
                {b.percent != null && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                      {/* 进度条宽度是运行时计算值——内联 style 合规例外 */}
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(b.percent * 100)}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {Math.round(b.percent * 100)}%
                    </span>
                  </div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: LibraryView 接入**

`src/renderer/library/LibraryView.tsx`：import 加 `import { RecentlyReadShelf } from "./RecentlyReadShelf";`。`<main className="p-6">` 内、`{books.isPending && ...}` 之前插入：

```tsx
<RecentlyReadShelf onOpen={openBook} />
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/query/keys.ts src/renderer/library/RecentlyReadShelf.tsx src/renderer/library/LibraryView.tsx
git commit -m "feat(renderer): recently-read shelf above library grid"
```

---

### Task 10: 主网格 dnd-kit 拖拽排序

**Files:**

- Create: `src/renderer/library/SortableBook.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`（grid 区 ~L166-176 + mutation 区）

- [ ] **Step 1: SortableBook wrapper**

`src/renderer/library/SortableBook.tsx`：

```tsx
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BookSummaryDto } from "@shared/library";
import { BookCover } from "./BookCover";

/**
 * 可排序书卡（#48 spec §6.2）：useSortable 包 BookCover。listeners 挂 li——
 * PointerSensor 带 distance 8px 激活约束（注入处见 LibraryView），普通点击仍走 onOpen，
 * 且只响应主键，右键 ContextMenu 不受影响。transform/transition 是运行时计算值（内联 style 合规）。
 */
export function SortableBook({
  book,
  onOpen,
  onDelete,
}: {
  book: BookSummaryDto;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: book.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...listeners}
    >
      <BookCover book={book} onOpen={onOpen} onDelete={onDelete} />
    </li>
  );
}
```

- [ ] **Step 2: LibraryView 接入 DndContext + reorder mutation**

`src/renderer/library/LibraryView.tsx`：

import 区加：

```tsx
import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import { createLogger } from "@renderer/logger";
import { SortableBook } from "./SortableBook";
```

（`createLogger` 仅在该文件尚无 logger 时新增 `const log = createLogger("library");`——按文件现状判断，已有则跳过。）

组件内（mutations 区之后）加：

```tsx
// 拖拽排序（#48 spec §6.2）：8px 位移激活（与点击打开互斥）；乐观更新缓存后全量 reorder，
// 失败 invalidate 恢复真序 + toast 透传真实错误（honest-error）。
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
const [draggingId, setDraggingId] = useState<string | null>(null);

const reorder = useMutation({
  mutationFn: (orderedIds: string[]) => window.api.library.reorder({ orderedIds }),
  onError: (e) => {
    void qc.invalidateQueries({ queryKey: qk.library });
    toast.error(
      t("library.reorderFailed", "排序保存失败：{{error}}", { error: (e as Error).message }),
      { closeButton: true, duration: Infinity },
    );
  },
});

const onDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id));
const onDragEnd = (e: DragEndEvent) => {
  setDraggingId(null);
  const { active, over } = e;
  if (!over || active.id === over.id) return;
  const list = books.data;
  if (!list) return;
  const from = list.findIndex((b) => b.id === active.id);
  const to = list.findIndex((b) => b.id === over.id);
  if (from < 0 || to < 0) return;
  const next = arrayMove(list, from, to);
  qc.setQueryData(qk.library, next); // 乐观：先动 UI
  reorder.mutate(next.map((b) => b.id));
};

const draggingBook = draggingId ? books.data?.find((b) => b.id === draggingId) : undefined;
```

grid 的 `<ul>...</ul>`（~L166-176）替换为：

```tsx
<DndContext
  sensors={sensors}
  onDragStart={onDragStart}
  onDragEnd={onDragEnd}
  onDragCancel={() => setDraggingId(null)}
>
  <SortableContext items={books.data?.map((b) => b.id) ?? []} strategy={rectSortingStrategy}>
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-5">
      {books.data?.map((b) => (
        <SortableBook
          key={b.id}
          book={b}
          onOpen={() => openBook(b.id)}
          onDelete={() => deleteBook.mutate(b)}
        />
      ))}
    </ul>
  </SortableContext>
  <DragOverlay>
    {draggingBook ? <BookCover book={draggingBook} onOpen={() => {}} onDelete={() => {}} /> : null}
  </DragOverlay>
</DndContext>
```

（`BookCover` 的 import 在 LibraryView 保留——DragOverlay 用到。）

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/library/SortableBook.tsx src/renderer/library/LibraryView.tsx
git commit -m "feat(renderer): drag-to-reorder library grid with dnd-kit"
```

---

### Task 11: i18n 同步 + 全量验证 + CDP 冒烟

**Files:**

- Modify: `src/renderer/i18n/locales/*`（i18n:extract 产出）
- 临时: `/tmp/smoke-shelf.mjs`（冒烟脚本，不入库）

- [ ] **Step 1: i18n extract（先于 typecheck——extract 用旧 fallback 反向覆盖的坑）**

Run: `pnpm i18n:extract`
然后 `git diff src/renderer/i18n/`——确认新增 key（`library.continueReading`、`library.reorderFailed`）落进 locale 文件且**没有把既有人工修正的译文反向覆盖**（i18n 坑：逐行看 diff，только新增行可接受；若出现对既有行的改动，恢复该行）。

- [ ] **Step 2: 全量静态验证**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: 全绿。

- [ ] **Step 3: 启动 dev 实例（CDP 冒烟准备）**

Run（后台）: `pnpm start -- --remote-debugging-port=9222 --user-data-dir=/tmp/marginalia-smoke-48`
（恰好一个 `--`——多一个裸 `--` 会让开关静默失效，dev 也吃 `--user-data-dir`。）

等待窗口起来后，通过 `curl -s http://localhost:9222/json/version` 拿 `webSocketDebuggerUrl`（CDP 连接必须用 ws URL，HTTP 端点 400）。

- [ ] **Step 4: 冒烟脚本**

先生成 fixture 文件（测试 fixture 工厂跑在 Electron 运行时——与 `pnpm test` 同机制）：

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e '
  const { makeFixtureEpub } = require("@marginalia/epub-parser");
  const { makeTextPdf } = require("@marginalia/pdf-parser/fixture");
  const { writeFileSync } = require("node:fs");
  writeFileSync("/tmp/fixture-a.epub", makeFixtureEpub());
  writeFileSync("/tmp/fixture-b.pdf", makeTextPdf());
'
```

（若 workspace 包名/导出在 require 下不可解析，退路：在仓库里建临时 `scripts/make-smoke-fixtures.mjs` 用 vitest 同款 import 跑一次后删除。）

写 `/tmp/smoke-shelf.mjs`（playwright-core 已在 devDeps；按下述骨架，按实际 DOM 微调选择器）：

```js
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const ver = await fetch("http://localhost:9222/json/version").then((r) => r.json());
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const page = browser.contexts()[0].pages()[0];

// ① 种数据：导入 fixture 书 + 直写两本的进度（percent 经 IPC 全链路）
// （fixture epub/pdf 文件提前用仓库脚本或测试 fixture 写到 /tmp）
const ids = await page.evaluate(async () => {
  const a = await window.api.library.import({ filePath: "/tmp/fixture-a.epub" });
  const b = await window.api.library.import({ filePath: "/tmp/fixture-b.pdf" });
  await window.api.progress.save({ bookId: a.id, locator: "epubcfi(/6/2!/4/1:0)", percent: 0.42 });
  await window.api.progress.save({
    bookId: b.id,
    locator: 'pdf:{"page":2,"scrollRatio":0}',
    percent: 0.5,
  });
  return [a.id, b.id];
});
await page.reload();

// ② shelf 断言：出现「继续阅读」+ 2 张卡 + 42% 文案；点击第一张进 reader
// ③ 面包屑断言：reader header 出现「%」文本；返回书库
// ④ 拖拽断言：mouse.down → move(>8px, 跨一张卡) → up；library:list 顺序变化且重启（reload）后保持
// ⑤ 手势隔离：mouse.down → move → press Escape（取消拖拽）→ 模拟文件 dragover 不崩、DropOverlay 正常
// 每步截图 writeFileSync 留证：page.screenshot({ path: "/tmp/smoke-48-<step>.png" })
```

Run: `node /tmp/smoke-shelf.mjs`
Expected: 脚本各断言通过；截图目检 shelf 形态（信息卡 + 进度条）、面包屑百分比、拖拽后顺序。

- [ ] **Step 5: 清理 + 修正循环**

杀掉 dev 实例（**精确 PID**，勿宽 pkill——会误杀别的 worktree 的 Electron）。冒烟发现的问题逐个修复：每修一个，回到对应 task 的验证步骤重跑，单独 commit（`fix(renderer): ...`）。

- [ ] **Step 6: changeset（用户可见变更，finishing 流程要求）**

Run: `pnpm changeset`——英文、用户向，描述三件事：recently-read shelf、drag-to-reorder、reading progress in reader header。

```bash
git add .changeset/
git commit -m "chore: add changeset for library shelf and reorder"
```

---

## 完成定义（DoD）

- [ ] 全部 task 提交完毕，`pnpm typecheck && pnpm lint && pnpm test` 绿
- [ ] CDP 冒烟 4 项通过（shelf 显示/点击、面包屑百分比、拖拽持久化、手势隔离）
- [ ] changeset 已写
- [ ] 交付后（finishing 流程）：ROADMAP 更新、kanban #48 挪列、commit 带 `closes #48`
