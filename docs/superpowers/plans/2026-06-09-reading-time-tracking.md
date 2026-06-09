# 阅读时长记录与统计页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记录用户实际阅读时长并提供独立统计页（总览 / 每日柱图 / streak / 各书排行），同时把顶层导航重构为 Apple Books 风 pill 标签 shell。

**Architecture:** 主进程「阅读时钟」纯状态机（注入 `now()` + `commit` sink，焦点/电源在 wiring 观测）累计到 `reading_daily(书×本地日)` 聚合桶；聚合纯函数算总览/streak/零填充，仓储做含 join 的 SQL。渲染层在 reader 外用 `AppShell` + pill 标签切「书库/统计」，reader 全屏接管。

**Tech Stack:** Electron 41 + better-sqlite3 + Drizzle ORM 1.0-rc · React 19（React Compiler，勿手写 useMemo/useCallback）+ TanStack Query + i18next · Zod 4 · vitest 4（跑在 Electron 运行时）· Tailwind。

**Spec:** `docs/superpowers/specs/2026-06-09-reading-time-tracking-design.md` · **Issue:** [#73](https://github.com/EurFelux/marginalia/issues/73)

**关键约束（务必遵守）：**

- 日志：每文件 `const log = createLogger("stats")`（主进程 `@main/logger`，渲染层 `@renderer/logger`）；优雅吞错处必留 `log.warn`，Error 作第二参。
- 样式：优先 Tailwind 工具类；内联 `style` 仅承载运行时计算值（柱图 bar 高度是运行时计算值，允许内联 `style={{ height }}`）。
- React Compiler：**不要**写 `useCallback`/`useMemo`；命令式 effect 清理仍要写。
- 提交：Conventional Commits；pre-commit 钩子（prek）会跑 lint:fix + format，若报「files were modified by this hook」就 `git add` 再 commit 一次。
- 测试只覆盖纯逻辑（主进程函数 + 渲染层纯 util），不为 React/Electron 胶水写测试。
- 路径别名 `@main/*` `@shared/*` `@renderer/*` 已在各 config 配好，直接用。

---

## File Structure

**新建：**

- `src/main/stats/day-key.ts` — `localDayKey(ms)` 本地日期键（纯）。
- `src/main/stats/day-key.test.ts`
- `src/main/stats/clock.ts` — `createReadingClock(deps)` 计时状态机（纯，注入 now/commit）。
- `src/main/stats/clock.test.ts`
- `src/main/stats/reading-daily.ts` — `addSeconds` / `dailyTotals` / `perBookTotals` 仓储。
- `src/main/stats/reading-daily.test.ts`
- `src/main/stats/aggregate.ts` — `aggregateStats(rows, dailyDays, today)` 纯聚合。
- `src/main/stats/aggregate.test.ts`
- `src/main/stats/clock-wiring.ts` — 接触 Electron 的胶水（窗口焦点 / powerMonitor / interval / commit sink）。
- `src/main/ipc/stats-handlers.ts` — `registerStatsHandlers()` + bindings。
- `src/shared/stats.ts` — Zod 输入 + DTO 类型（单一源）。
- `src/renderer/shell/AppShell.tsx` — reader 外的外层 shell（顶栏 + 当前 tab）。
- `src/renderer/shell/ShellHeader.tsx` — 品牌 + pill 标签 + 设置。
- `src/renderer/stats/StatsView.tsx` — 统计页容器。
- `src/renderer/stats/StatOverview.tsx` / `DailyBarChart.tsx` / `StreakCard.tsx` / `BookRanking.tsx` — 子组件。
- `src/renderer/stats/format-duration.ts` — `formatDuration` 纯 util。
- `src/renderer/stats/format-duration.test.ts`
- `src/renderer/reader/use-reading-clock.ts` — 进/出 reader 上报阅读状态。

**修改：**

- `src/main/db/schema.ts` — 加 `readingDaily` 表。
- `src/main/db/migrations/` — `pnpm db:generate` 生成新迁移目录。
- `src/shared/ipc.ts` — 注册 `statsReadingState` / `statsGet` 契约。
- `src/preload-api.ts` — 暴露 `window.api.stats`。
- `src/main.ts` — `registerStatsHandlers()` + `initReadingClock()`（app.ready）+ `bindWindowToClock(mainWindow)`（createWindow）。
- `src/renderer/store/navigation-store.ts` — `view` 增 `"stats"` + `showLibrary`/`showStats`。
- `src/renderer/App.tsx` — `view === "reader" ? <ReaderView/> : <AppShell/>`。
- `src/renderer/library/LibraryView.tsx` — 去掉自带 header；导入按钮移入内容区工具条；根改 `h-full`。
- `src/renderer/reader/ReaderView.tsx` — 调 `useReadingClock(bookId)`。
- `src/renderer/query/keys.ts` — 加 `qk.stats`。
- `src/shared/i18n/locales/zh-CN.ts` / `en.ts` — 新键（extract 同步 + 补 en）。

---

## Task 1: 数据库表 `reading_daily`

**Files:**

- Modify: `src/main/db/schema.ts`
- Generate: `src/main/db/migrations/<timestamp>_*/`

- [ ] **Step 1: 在 schema.ts 末尾加表定义**

在 `src/main/db/schema.ts` 文件末尾（`preferences` 表定义之后）追加。`unique` / `index` / `integer` / `text` 已在文件顶部 import，`pkUuid` / `books` 已定义，无需新增 import：

```ts
// 阅读时长按 (书 × 本地日期) 累计（spec 2026-06-09-reading-time-tracking §2）。
// 删书 set null 保留时长历史：bookId 置空后该行仍计入 总时长/每日柱图/streak，仅各书排行不再列它。
export const readingDaily = sqliteTable(
  "reading_daily",
  {
    id: pkUuid(),
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    day: text("day").notNull(), // 本地日期 'YYYY-MM-DD'
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [
    unique("reading_daily_book_day_unique").on(t.bookId, t.day),
    index("reading_daily_day_idx").on(t.day),
    index("reading_daily_book_id_idx").on(t.bookId),
  ],
);
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新建目录 `src/main/db/migrations/<timestamp>_<name>/`，含 `migration.sql`（`CREATE TABLE reading_daily ...` + 三条索引/唯一约束）与 `snapshot.json`。**不要手工编辑迁移文件。**

- [ ] **Step 3: 验证迁移可应用（typecheck + 既有测试不挂）**

Run: `pnpm typecheck && pnpm test src/main/library/progress.test.ts`
Expected: typecheck 通过；progress 测试 PASS（确认 `createDb(":memory:")` → `runMigrations` 能应用新迁移，不报 SQL 错）。

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(stats): add reading_daily table and migration"
```

---

## Task 2: shared 契约 `src/shared/stats.ts` + IPC 注册 + preload

**Files:**

- Create: `src/shared/stats.ts`
- Modify: `src/shared/ipc.ts`, `src/preload-api.ts`

- [ ] **Step 1: 写 `src/shared/stats.ts`**

```ts
import { z } from "zod";

/** 渲染层 → 主进程：进/出 reader（含设置弹窗遮挡 reader 时上报 null）。 */
export const statsReadingStateInput = z.object({ bookId: z.string().min(1).nullable() });
export type StatsReadingStateInput = z.infer<typeof statsReadingStateInput>;

/** 统计页取数；dailyDays 控制每日柱图窗口（默认 30）。 */
export const statsGetInput = z.object({
  dailyDays: z.number().int().positive().max(366).optional(),
});
export type StatsGetInput = z.infer<typeof statsGetInput>;

/** 某日合计（dailyTotals 的元素 / 柱图点）。 */
export interface DailyPoint {
  day: string; // 'YYYY-MM-DD'
  seconds: number;
}

/** 各书时长（perBookTotals 元素，仅现存书）。 */
export interface BookReadingTotal {
  bookId: string;
  title: string | null;
  author: string | null;
  seconds: number;
}

/** 统计页一次性数据。 */
export interface ReadingStatsDto {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number; // 滚动近 7 天（今天及前 6 天）
  currentStreak: number;
  longestStreak: number;
  readingDays: number;
  daily: DailyPoint[]; // 近 dailyDays 天，升序、零填充
  perBook: BookReadingTotal[]; // 按 seconds 降序，仅现存书
}
```

- [ ] **Step 2: 在 `src/shared/ipc.ts` 注册契约**

在 import 区加（与既有同风格）：

```ts
import type { ReadingStatsDto } from "@shared/stats";
import { statsGetInput, statsReadingStateInput } from "@shared/stats";
```

在 `C` 对象内、`// logging` 段之前加一段：

```ts
  // stats（阅读时长）
  statsReadingState: def("stats:reading-state", "invoke", statsReadingStateInput, out<void>()),
  statsGet: def("stats:get", "invoke", statsGetInput, out<ReadingStatsDto>()),
```

- [ ] **Step 3: 在 `src/preload-api.ts` 暴露**

在 `createApi` 返回对象内（`ai:` 之后）加：

```ts
    stats: {
      readingState: inv(C.statsReadingState),
      get: inv(C.statsGet),
    },
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 通过（若有 IPC 契约↔preload 漂移测试也应仍绿）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/stats.ts src/shared/ipc.ts src/preload-api.ts
git commit -m "feat(stats): add stats IPC contracts and preload surface"
```

---

## Task 3: `localDayKey` 本地日期键（TDD）

**Files:**

- Create: `src/main/stats/day-key.ts`, `src/main/stats/day-key.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/stats/day-key.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { localDayKey } from "@main/stats/day-key";

// 用「本地分量构造 → 读回本地分量」避免测试机时区依赖：noon/边界都用本地时间字面量。
describe("localDayKey", () => {
  it("formats local date as YYYY-MM-DD", () => {
    const ms = new Date("2026-06-09T12:00:00").getTime();
    expect(localDayKey(ms)).toBe("2026-06-09");
  });
  it("zero-pads month and day", () => {
    const ms = new Date("2026-01-05T08:30:00").getTime();
    expect(localDayKey(ms)).toBe("2026-01-05");
  });
  it("rolls to next day after local midnight", () => {
    expect(localDayKey(new Date("2026-06-09T23:30:00").getTime())).toBe("2026-06-09");
    expect(localDayKey(new Date("2026-06-10T00:30:00").getTime())).toBe("2026-06-10");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/stats/day-key.test.ts`
Expected: FAIL（`Cannot find module '@main/stats/day-key'`）。

- [ ] **Step 3: 实现**

`src/main/stats/day-key.ts`：

```ts
/** 把毫秒时间戳格式化为**本地**日期键 'YYYY-MM-DD'（纯函数）。 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/stats/day-key.test.ts`
Expected: PASS（3 个）。

- [ ] **Step 5: Commit**

```bash
git add src/main/stats/day-key.ts src/main/stats/day-key.test.ts
git commit -m "feat(stats): add localDayKey helper"
```

---

## Task 4: 阅读时钟状态机 `clock.ts`（TDD）

**Files:**

- Create: `src/main/stats/clock.ts`, `src/main/stats/clock.test.ts`

时钟语义：`active = currentBookId != null && isFocused && isAwake`。任一状态翻转先结算旧状态再切换；`tick()` 周期结算并进位 `activeSince`（防漂移）；结算把 `floor((now-activeSince)/1000)` 秒经 `commit(bookId, now, seconds)` 落账。

- [ ] **Step 1: 写失败测试**

`src/main/stats/clock.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createReadingClock } from "@main/stats/clock";

function setup(start = 0) {
  let now = start;
  const commits: { bookId: string; atMs: number; seconds: number }[] = [];
  const clock = createReadingClock({
    now: () => now,
    commit: (bookId, atMs, seconds) => commits.push({ bookId, atMs, seconds }),
  });
  return { clock, commits, advance: (ms: number) => (now += ms), setNow: (v: number) => (now = v) };
}

describe("createReadingClock", () => {
  it("does not commit while inactive (no book / blurred / asleep)", () => {
    const { clock, commits, advance } = setup();
    clock.setFocused(true);
    clock.setAwake(true);
    advance(60_000); // 无 book → 不活跃
    clock.tick();
    expect(commits).toEqual([]);
  });

  it("accumulates seconds for the active book on tick", () => {
    const { clock, commits, advance } = setup();
    clock.setFocused(true);
    clock.setAwake(true);
    clock.setReadingBook("b1"); // 此刻起活跃
    advance(90_000);
    clock.tick();
    expect(commits).toEqual([{ bookId: "b1", atMs: 90_000, seconds: 90 }]);
  });

  it("settles elapsed time on blur (active -> inactive)", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(30_000);
    clock.setFocused(false); // 结算
    expect(commits).toEqual([{ bookId: "b1", atMs: 30_000, seconds: 30 }]);
    advance(60_000); // 失焦期间不计
    clock.tick();
    expect(commits).toHaveLength(1);
  });

  it("settles old book before switching books", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(20_000);
    clock.setReadingBook("b2"); // 先结算 b1 再切
    advance(10_000);
    clock.tick();
    expect(commits).toEqual([
      { bookId: "b1", atMs: 20_000, seconds: 20 },
      { bookId: "b2", atMs: 30_000, seconds: 10 },
    ]);
  });

  it("carries sub-second remainder across ticks (no drift)", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(1_500);
    clock.tick(); // 提交 1s，余 500ms 进位
    advance(1_500);
    clock.tick(); // 累计 2000ms → 提交 2s
    expect(commits).toEqual([
      { bookId: "b1", atMs: 1_500, seconds: 1 },
      { bookId: "b1", atMs: 3_000, seconds: 2 },
    ]);
  });

  it("does not commit zero-second ticks", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(500);
    clock.tick();
    expect(commits).toEqual([]);
  });

  it("setReadingBook(null) settles and stops", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(45_000);
    clock.setReadingBook(null);
    expect(commits).toEqual([{ bookId: "b1", atMs: 45_000, seconds: 45 }]);
    advance(60_000);
    clock.tick();
    expect(commits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/stats/clock.test.ts`
Expected: FAIL（`Cannot find module '@main/stats/clock'`）。

- [ ] **Step 3: 实现**

`src/main/stats/clock.ts`：

```ts
export interface ReadingClockDeps {
  /** 当前时间（ms）。注入便于测试。 */
  now: () => number;
  /** 落账：把某书一段秒数记到 atMs 所属日期（day 归属由 sink 用 localDayKey 计算）。 */
  commit: (bookId: string, atMs: number, seconds: number) => void;
}

export interface ReadingClock {
  setReadingBook: (bookId: string | null) => void;
  setFocused: (focused: boolean) => void;
  setAwake: (awake: boolean) => void;
  /** 周期 flush（结算并进位）。 */
  tick: () => void;
  /** 仅供测试观察。 */
  getState: () => {
    currentBookId: string | null;
    isFocused: boolean;
    isAwake: boolean;
    activeSince: number | null;
  };
}

/** 阅读时钟纯状态机：active = 有书 && 聚焦 && 未休眠。 */
export function createReadingClock(deps: ReadingClockDeps): ReadingClock {
  let currentBookId: string | null = null;
  let isFocused = false;
  let isAwake = false;
  let activeSince: number | null = null;

  const isActive = () => currentBookId != null && isFocused && isAwake;

  /** 结算已累计的整秒并进位 activeSince（保留 <1s 余数，防长会话漂移）。 */
  function settle(): void {
    if (activeSince == null || !isActive() || currentBookId == null) return;
    const t = deps.now();
    const seconds = Math.floor((t - activeSince) / 1000);
    if (seconds > 0) {
      deps.commit(currentBookId, t, seconds);
      activeSince += seconds * 1000;
    }
  }

  /** 状态翻转：先按旧状态结算，再切换，再重置活跃段起点。 */
  function transition(mutate: () => void): void {
    settle();
    mutate();
    activeSince = isActive() ? deps.now() : null;
  }

  return {
    setReadingBook: (bookId) => transition(() => (currentBookId = bookId)),
    setFocused: (focused) => transition(() => (isFocused = focused)),
    setAwake: (awake) => transition(() => (isAwake = awake)),
    tick: () => settle(),
    getState: () => ({ currentBookId, isFocused, isAwake, activeSince }),
  };
}
```

> 注：`transition` 在「同值重复调用」（如 setFocused(true) 已 true）时会 settle 并把 activeSince 重置为 now（丢 <1s 余数）。状态翻转稀疏，可接受；周期 tick 走 `settle()` 进位路径不丢。测试 `carries sub-second remainder` 即覆盖 tick 路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/stats/clock.test.ts`
Expected: PASS（7 个）。

- [ ] **Step 5: Commit**

```bash
git add src/main/stats/clock.ts src/main/stats/clock.test.ts
git commit -m "feat(stats): add reading clock state machine"
```

---

## Task 5: 仓储 `reading-daily.ts`（TDD，:memory:）

**Files:**

- Create: `src/main/stats/reading-daily.ts`, `src/main/stats/reading-daily.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/stats/reading-daily.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { addSeconds, dailyTotals, perBookTotals } from "@main/stats/reading-daily";

function insertBook(db: DB, id: string, title: string | null) {
  db.insert(books).values({ id, title, author: null }).run();
}

describe("reading-daily repository", () => {
  let db: DB;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("addSeconds upserts and accumulates per (book, day)", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 30);
    addSeconds(db, "b1", "2026-06-09", 15);
    addSeconds(db, "b1", "2026-06-10", 20);
    expect(dailyTotals(db)).toEqual([
      { day: "2026-06-09", seconds: 45 },
      { day: "2026-06-10", seconds: 20 },
    ]);
  });

  it("ignores non-positive seconds", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 0);
    addSeconds(db, "b1", "2026-06-09", -5);
    expect(dailyTotals(db)).toEqual([]);
  });

  it("dailyTotals sums across books per day", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    addSeconds(db, "b1", "2026-06-09", 30);
    addSeconds(db, "b2", "2026-06-09", 70);
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 100 }]);
  });

  it("perBookTotals ranks existing books desc", () => {
    insertBook(db, "b1", "Book 1");
    insertBook(db, "b2", "Book 2");
    addSeconds(db, "b1", "2026-06-09", 100);
    addSeconds(db, "b2", "2026-06-09", 300);
    expect(perBookTotals(db)).toEqual([
      { bookId: "b2", title: "Book 2", author: null, seconds: 300 },
      { bookId: "b1", title: "Book 1", author: null, seconds: 100 },
    ]);
  });

  it("preserves time history on book delete (set null): still in dailyTotals, gone from perBook", () => {
    insertBook(db, "b1", "Book 1");
    addSeconds(db, "b1", "2026-06-09", 120);
    db.delete(books).where(eqId("b1")).run();
    // 删书后 bookId set null：仍计入每日合计，但不再出现在各书排行。
    expect(dailyTotals(db)).toEqual([{ day: "2026-06-09", seconds: 120 }]);
    expect(perBookTotals(db)).toEqual([]);
  });
});

// 局部 helper（避免在测试顶层引 drizzle 操作符噪音）。
import { eq } from "drizzle-orm";
import { books as booksTable } from "@main/db/schema";
function eqId(id: string) {
  return eq(booksTable.id, id);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/stats/reading-daily.test.ts`
Expected: FAIL（`Cannot find module '@main/stats/reading-daily'`）。

- [ ] **Step 3: 实现**

`src/main/stats/reading-daily.ts`：

```ts
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, readingDaily } from "@main/db/schema";
import type { BookReadingTotal, DailyPoint } from "@shared/stats";

/** 累加某书某本地日的阅读秒数（upsert on (bookId, day)）。非正秒数忽略。 */
export function addSeconds(db: DB, bookId: string, day: string, seconds: number): void {
  if (seconds <= 0) return;
  db.insert(readingDaily)
    .values({ bookId, day, seconds })
    .onConflictDoUpdate({
      target: [readingDaily.bookId, readingDaily.day],
      set: { seconds: sql`${readingDaily.seconds} + ${seconds}` },
    })
    .run();
}

/** 每日合计（跨全部书，含已删书的 bookId=null 行），按 day 升序。 */
export function dailyTotals(db: DB): DailyPoint[] {
  return db
    .select({ day: readingDaily.day, seconds: sql<number>`sum(${readingDaily.seconds})` })
    .from(readingDaily)
    .groupBy(readingDaily.day)
    .orderBy(readingDaily.day)
    .all();
}

/** 各书合计，仅现存书（inner join 天然排除 bookId=null），按秒降序。 */
export function perBookTotals(db: DB): BookReadingTotal[] {
  return db
    .select({
      bookId: books.id,
      title: books.title,
      author: books.author,
      seconds: sql<number>`sum(${readingDaily.seconds})`,
    })
    .from(readingDaily)
    .innerJoin(books, eq(readingDaily.bookId, books.id))
    .groupBy(books.id)
    .orderBy(desc(sql`sum(${readingDaily.seconds})`))
    .all();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/stats/reading-daily.test.ts`
Expected: PASS（5 个）。

- [ ] **Step 5: Commit**

```bash
git add src/main/stats/reading-daily.ts src/main/stats/reading-daily.test.ts
git commit -m "feat(stats): add reading-daily repository"
```

---

## Task 6: 聚合纯函数 `aggregate.ts`（TDD）

**Files:**

- Create: `src/main/stats/aggregate.ts`, `src/main/stats/aggregate.test.ts`

`aggregateStats(rows, dailyDays, today)` 输入全历史 `DailyPoint[]` + 窗口 + 参考日，产出 `ReadingStatsDto` 中除 `perBook` 外的全部字段。streak 阈值 60s。

- [ ] **Step 1: 写失败测试**

`src/main/stats/aggregate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { aggregateStats } from "@main/stats/aggregate";

describe("aggregateStats", () => {
  const today = "2026-06-09";

  it("computes total / today / rolling-week", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 600 }, // today
        { day: "2026-06-05", seconds: 300 }, // within 7d
        { day: "2026-06-02", seconds: 100 }, // outside 7d (today-7)
      ],
      30,
      today,
    );
    expect(r.totalSeconds).toBe(1000);
    expect(r.todaySeconds).toBe(600);
    expect(r.weekSeconds).toBe(900); // 06-03..06-09 含 today 及前6天
  });

  it("daily is ascending, zero-filled, windowed to dailyDays", () => {
    const r = aggregateStats([{ day: "2026-06-09", seconds: 120 }], 3, today);
    expect(r.daily).toEqual([
      { day: "2026-06-07", seconds: 0 },
      { day: "2026-06-08", seconds: 0 },
      { day: "2026-06-09", seconds: 120 },
    ]);
  });

  it("daily window does not affect total/streak (full history counts)", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 120 },
        { day: "2026-01-01", seconds: 999 }, // 在 dailyDays=3 窗口外
      ],
      3,
      today,
    );
    expect(r.totalSeconds).toBe(1119);
    expect(r.daily).toHaveLength(3); // 不含 01-01
  });

  it("counts a day toward streak only at >= 60s", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 60 },
        { day: "2026-06-08", seconds: 59 }, // 不达标 → 断
        { day: "2026-06-07", seconds: 120 },
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(1); // 仅 today
    expect(r.readingDays).toBe(2); // 06-09 与 06-07
  });

  it("current streak counts consecutive qualifying days ending today", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-09", seconds: 100 },
        { day: "2026-06-08", seconds: 100 },
        { day: "2026-06-07", seconds: 100 },
        { day: "2026-06-05", seconds: 100 }, // 06-06 缺 → 断
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(3);
  });

  it("grace: streak alive through yesterday when today not read yet", () => {
    const r = aggregateStats(
      [
        { day: "2026-06-08", seconds: 100 },
        { day: "2026-06-07", seconds: 100 },
      ],
      30,
      today,
    );
    expect(r.currentStreak).toBe(2); // today 未读但昨日达标，宽限
  });

  it("current streak is 0 when neither today nor yesterday qualifies", () => {
    const r = aggregateStats([{ day: "2026-06-06", seconds: 100 }], 30, today);
    expect(r.currentStreak).toBe(0);
  });

  it("longest streak is max run over all history", () => {
    const r = aggregateStats(
      [
        { day: "2026-05-01", seconds: 100 },
        { day: "2026-05-02", seconds: 100 },
        { day: "2026-05-03", seconds: 100 },
        { day: "2026-05-04", seconds: 100 }, // 4 连
        { day: "2026-06-09", seconds: 100 }, // 单独 1
      ],
      30,
      today,
    );
    expect(r.longestStreak).toBe(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/stats/aggregate.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/main/stats/aggregate.ts`：

```ts
import type { DailyPoint, ReadingStatsDto } from "@shared/stats";

/** 当天合计达此秒数才算「读过书的一天」（streak / readingDays 计入门槛）。 */
export const STREAK_MIN_SECONDS = 60;

/** 'YYYY-MM-DD' 加减天（按本地分量构造 Date 做日历运算，时区稳定）。 */
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 全历史日合计 → 统计 DTO（除 perBook）。 */
export function aggregateStats(
  rows: DailyPoint[],
  dailyDays: number,
  today: string,
): Omit<ReadingStatsDto, "perBook"> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.day, (map.get(r.day) ?? 0) + r.seconds);
  const secondsOf = (day: string) => map.get(day) ?? 0;
  const qualifies = (day: string) => secondsOf(day) >= STREAK_MIN_SECONDS;

  let totalSeconds = 0;
  for (const v of map.values()) totalSeconds += v;

  const todaySeconds = secondsOf(today);

  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) weekSeconds += secondsOf(addDays(today, -i));

  const daily: DailyPoint[] = [];
  for (let i = dailyDays - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    daily.push({ day, seconds: secondsOf(day) });
  }

  // current streak：锚点 = 今天(达标) 否则昨天(达标) 否则无；自锚点向前数连续达标。
  let anchor: string | null = null;
  if (qualifies(today)) anchor = today;
  else if (qualifies(addDays(today, -1))) anchor = addDays(today, -1);
  let currentStreak = 0;
  for (let cur = anchor; cur != null && qualifies(cur); cur = addDays(cur, -1)) currentStreak++;

  // longest streak：全历史达标日的最长连续段。
  const qualifyingDays = [...map.keys()].filter(qualifies).sort();
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of qualifyingDays) {
    run = prev != null && addDays(prev, 1) === day ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = day;
  }

  return {
    totalSeconds,
    todaySeconds,
    weekSeconds,
    currentStreak,
    longestStreak,
    readingDays: qualifyingDays.length,
    daily,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/stats/aggregate.test.ts`
Expected: PASS（8 个）。

- [ ] **Step 5: Commit**

```bash
git add src/main/stats/aggregate.ts src/main/stats/aggregate.test.ts
git commit -m "feat(stats): add stats aggregation pure functions"
```

---

## Task 7: 时钟胶水 `clock-wiring.ts`

**Files:**

- Create: `src/main/stats/clock-wiring.ts`

powerMonitor/interval 仅 app.ready 挂一次（`initReadingClock`）；窗口焦点每窗绑定（`bindWindowToClock`），窗口 reload/closed 复位 `setReadingBook(null)` 防陈旧。

- [ ] **Step 1: 实现（无单测——纯 Electron 胶水）**

`src/main/stats/clock-wiring.ts`：

```ts
import { app, powerMonitor, type BrowserWindow } from "electron";
import { getDb } from "@main/db/instance";
import { createReadingClock, type ReadingClock } from "@main/stats/clock";
import { localDayKey } from "@main/stats/day-key";
import { addSeconds } from "@main/stats/reading-daily";
import { createLogger } from "@main/logger";

const log = createLogger("stats");

/** flush 周期：崩溃最多丢一个间隔；跨午夜由按 atMs 重算 day 自然切分。 */
const FLUSH_INTERVAL_MS = 60_000;

let clock: ReadingClock | null = null;

/** 供 IPC handler 调用的时钟句柄。 */
export function getReadingClock(): ReadingClock {
  if (!clock) throw new Error("reading clock not initialized");
  return clock;
}

/** app.ready 调一次：建时钟 + 接 powerMonitor + 周期 flush + 退出收尾。 */
export function initReadingClock(): void {
  if (clock) return;
  clock = createReadingClock({
    now: () => Date.now(),
    commit: (bookId, atMs, seconds) => {
      try {
        addSeconds(getDb(), bookId, localDayKey(atMs), seconds);
      } catch (err) {
        log.warn("commit reading time failed", err);
      }
    },
  });
  clock.setAwake(true);
  powerMonitor.on("suspend", () => clock?.setAwake(false));
  powerMonitor.on("resume", () => clock?.setAwake(true));
  powerMonitor.on("lock-screen", () => clock?.setAwake(false)); // macOS/Windows；缺失时 suspend 兜底
  powerMonitor.on("unlock-screen", () => clock?.setAwake(true));
  const interval = setInterval(() => clock?.tick(), FLUSH_INTERVAL_MS);
  app.on("before-quit", () => {
    clearInterval(interval);
    clock?.tick();
  });
}

/** createWindow 调：绑定窗口焦点；reload/closed 复位 currentBook。 */
export function bindWindowToClock(win: BrowserWindow): void {
  const c = getReadingClock();
  c.setFocused(win.isFocused());
  win.on("focus", () => c.setFocused(true));
  win.on("blur", () => c.setFocused(false));
  win.webContents.on("did-finish-load", () => c.setReadingBook(null));
  win.on("closed", () => c.setReadingBook(null));
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/main/stats/clock-wiring.ts
git commit -m "feat(stats): wire reading clock to window focus and power events"
```

---

## Task 8: IPC handlers + 接线进 main.ts

**Files:**

- Create: `src/main/ipc/stats-handlers.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 写 handlers**

`src/main/ipc/stats-handlers.ts`：

```ts
import { C } from "@shared/ipc";
import type { ReadingStatsDto } from "@shared/stats";
import { getDb } from "@main/db/instance";
import { aggregateStats } from "@main/stats/aggregate";
import { localDayKey } from "@main/stats/day-key";
import { dailyTotals, perBookTotals } from "@main/stats/reading-daily";
import { getReadingClock } from "@main/stats/clock-wiring";
import { bind, register, type Binding } from "@main/ipc/registry";

export const statsBindings: Binding[] = [
  bind(C.statsReadingState, (input) => {
    getReadingClock().setReadingBook(input.bookId);
  }),
  bind(C.statsGet, (input): ReadingStatsDto => {
    const db = getDb();
    const core = aggregateStats(dailyTotals(db), input.dailyDays ?? 30, localDayKey(Date.now()));
    return { ...core, perBook: perBookTotals(db) };
  }),
];

export function registerStatsHandlers(): void {
  register(statsBindings);
}
```

- [ ] **Step 2: 接线进 `src/main.ts`**

加 import（与既有 register\*Handlers import 同处）：

```ts
import { registerStatsHandlers } from "@main/ipc/stats-handlers";
import { initReadingClock, bindWindowToClock } from "@main/stats/clock-wiring";
```

在 `app.on("ready", ...)` 内、`registerLogHandlers();` 之后加：

```ts
registerStatsHandlers();
initReadingClock();
```

在 `createWindow` 内、`mainWindow` 创建并 `loadURL`/`loadFile` 之后（DevTools 那段之前或之后均可）加：

```ts
bindWindowToClock(mainWindow);
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/stats-handlers.ts src/main.ts
git commit -m "feat(stats): register stats IPC handlers and init reading clock"
```

---

## Task 9: 导航 store 加 stats 视图

**Files:**

- Modify: `src/renderer/store/navigation-store.ts`

- [ ] **Step 1: 改 view 类型与 actions**

在 `NavigationState` 把 `view` 改为：

```ts
view: "library" | "stats" | "reader";
```

在 `NavigationActions` 接口加：

```ts
  showLibrary: () => void;
  showStats: () => void;
```

在 store 实现里（`backToLibrary` 附近）加：

```ts
  showLibrary: () => set({ view: "library" }),
  showStats: () => set({ view: "stats" }),
```

`NAVIGATION_INITIAL.view` 保持 `"library"`，`openBook`/`backToLibrary` 不变。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过（App.tsx 仍 `view === "reader" ? ... : <LibraryView/>`，类型仍兼容；下一任务再换 AppShell）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/navigation-store.ts
git commit -m "feat(stats): add stats view to navigation store"
```

---

## Task 10: `ShellHeader`（品牌 + pill 标签 + 设置）

**Files:**

- Create: `src/renderer/shell/ShellHeader.tsx`

pill 手搭两按钮（避开 Base UI tabs 的 data-orientation 坑），激活态按 `view` 派生。

- [ ] **Step 1: 实现**

`src/renderer/shell/ShellHeader.tsx`：

```tsx
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useSettingsStore } from "@renderer/store/settings-store";

export function ShellHeader() {
  const { t } = useTranslation();
  const view = useNavigationStore((s) => s.view);
  const showLibrary = useNavigationStore((s) => s.showLibrary);
  const showStats = useNavigationStore((s) => s.showStats);
  const openSettings = useSettingsStore((s) => s.setOpen);

  const pill = (active: boolean) =>
    cn(
      "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border px-6">
      <div className="flex-1">
        <h1 className="font-serif text-xl font-semibold">{t("library.title", "Marginalia")}</h1>
      </div>
      <nav className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted p-1">
        <button type="button" onClick={showLibrary} className={pill(view === "library")}>
          {t("shell.tabLibrary", "书库")}
        </button>
        <button type="button" onClick={showStats} className={pill(view === "stats")}>
          {t("shell.tabStats", "统计")}
        </button>
      </nav>
      <div className="flex flex-1 justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openSettings(true)}
                aria-label={t("settings.title", "设置")}
                className="text-muted-foreground"
              />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent>{t("settings.title", "设置")}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/shell/ShellHeader.tsx
git commit -m "feat(stats): add ShellHeader with pill tab navigation"
```

---

## Task 11: `AppShell` + App.tsx 接线

**Files:**

- Create: `src/renderer/shell/AppShell.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 写 AppShell**

`src/renderer/shell/AppShell.tsx`（StatsView 下一任务才建；本步先引会 typecheck 报错——故本任务把 StatsView 占位为最简组件，Task 15 再补全）：

```tsx
import { useNavigationStore } from "@renderer/store/navigation-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { StatsView } from "@renderer/stats/StatsView";
import { ShellHeader } from "@renderer/shell/ShellHeader";

export function AppShell() {
  const view = useNavigationStore((s) => s.view);
  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <ShellHeader />
      <div className="min-h-0 flex-1">{view === "stats" ? <StatsView /> : <LibraryView />}</div>
    </div>
  );
}
```

- [ ] **Step 2: 建 StatsView 占位（Task 15 补全）**

`src/renderer/stats/StatsView.tsx`：

```tsx
export function StatsView() {
  return <div className="p-6">stats</div>;
}
```

- [ ] **Step 3: 改 App.tsx**

把 `import { LibraryView } ...` 改为 `import { AppShell } from "@renderer/shell/AppShell";`（删 LibraryView import），并把渲染行改为：

```tsx
{
  view === "reader" ? <ReaderView /> : <AppShell />;
}
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/shell/AppShell.tsx src/renderer/stats/StatsView.tsx src/renderer/App.tsx
git commit -m "feat(stats): add AppShell and route non-reader views through it"
```

---

## Task 12: LibraryView 重构（去 header，导入移入内容区）

**Files:**

- Modify: `src/renderer/library/LibraryView.tsx`

- [ ] **Step 1: 改 import 行**

删掉不再用的 `Settings` 图标与 settings-store 依赖；保留 `BookOpen` `FolderOpen`。把：

```ts
import { BookOpen, FolderOpen, Settings } from "lucide-react";
```

改为：

```ts
import { BookOpen, FolderOpen } from "lucide-react";
```

删掉这两行（设置已上移到 ShellHeader）：

```ts
import { useSettingsStore } from "@renderer/store/settings-store";
```

```ts
const openSettings = useSettingsStore((s) => s.setOpen);
```

- [ ] **Step 2: 换根容器 + 用工具条替换 header**

把根 `<div {...rootHandlers} className="flex h-screen flex-col bg-background font-sans text-foreground overflow-hidden">` 的 `h-screen` 改为 `h-full`（已在 AppShell 的 flex 列内）：

```tsx
    <div
      {...rootHandlers}
      className="flex h-full flex-col bg-background font-sans text-foreground overflow-hidden"
    >
```

把整个 `<header>...</header>` 块替换为内容区工具条：

```tsx
<div className="flex h-12 shrink-0 items-center justify-between px-6">
  <span className="text-sm text-muted-foreground">
    {t("library.count", "共 {{count}} 本", { count: books.data?.length ?? 0 })}
  </span>
  <Button onClick={() => void onPick()} disabled={importBooks.isPending}>
    <FolderOpen />
    {importBooks.isPending
      ? t("library.importPending", "导入中…")
      : t("library.import", "导入书籍")}
  </Button>
</div>
```

- [ ] **Step 3: 更新空库引导文案（导入已不在右上角）**

把 empty 文案默认值由「点右上角…」改为指向工具条：

```tsx
<p className="text-sm">
  {t("library.empty", "书库为空，点上方「导入书籍」或把 .epub / .pdf 拖进窗口开始。")}
</p>
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 通过（无未用 import）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/library/LibraryView.tsx
git commit -m "feat(stats): move import into library toolbar, drop library header"
```

---

## Task 13: `useReadingClock` 上报 + 接入 ReaderView

**Files:**

- Create: `src/renderer/reader/use-reading-clock.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: 写 hook**

`src/renderer/reader/use-reading-clock.ts`：

```ts
import { useEffect } from "react";
import { createLogger } from "@renderer/logger";
import { useSettingsStore } from "@renderer/store/settings-store";

const log = createLogger("stats");

/** 进/出 reader 时向主进程上报阅读状态；设置弹窗遮挡 reader 时上报 null（暂停）。
 * 焦点/电源由主进程观测，此处只管「是否在 reader 且未被设置弹窗遮挡」。 */
export function useReadingClock(bookId: string | null): void {
  const settingsOpen = useSettingsStore((s) => s.open);
  useEffect(() => {
    const target = bookId != null && !settingsOpen ? bookId : null;
    void window.api.stats
      .readingState({ bookId: target })
      .catch((err: unknown) => log.warn("reading-state report failed", err));
  }, [bookId, settingsOpen]);
  // 卸载（离开 reader）时复位 null。
  useEffect(
    () => () => {
      void window.api.stats.readingState({ bookId: null }).catch(() => {});
    },
    [],
  );
}
```

- [ ] **Step 2: 接入 ReaderView**

在 `src/renderer/reader/ReaderView.tsx` 顶部 import 区加：

```ts
import { useReadingClock } from "@renderer/reader/use-reading-clock";
```

在 `ReaderView` 组件体内、`const bookId = useNavigationStore((s) => s.currentBookId);` 之后加一行：

```ts
useReadingClock(bookId);
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/use-reading-clock.ts src/renderer/reader/ReaderView.tsx
git commit -m "feat(stats): report reading state from reader view"
```

---

## Task 14: `formatDuration` 纯 util（TDD）

**Files:**

- Create: `src/renderer/stats/format-duration.ts`, `src/renderer/stats/format-duration.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/stats/format-duration.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatDuration } from "@renderer/stats/format-duration";

describe("formatDuration", () => {
  const f = (s: number) => formatDuration(s, "h", "m");
  it("formats sub-hour as minutes", () => {
    expect(f(2820)).toBe("47m"); // 47:00
    expect(f(60)).toBe("1m");
  });
  it("floors sub-minute to 0m", () => {
    expect(f(0)).toBe("0m");
    expect(f(59)).toBe("0m");
  });
  it("omits minutes when whole hours", () => {
    expect(f(3600)).toBe("1h");
    expect(f(7200)).toBe("2h");
  });
  it("shows hours and minutes", () => {
    expect(f(4320)).toBe("1h 12m"); // 72m
    expect(f(7320)).toBe("2h 2m");
  });
  it("clamps negatives to 0m", () => {
    expect(f(-10)).toBe("0m");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/stats/format-duration.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/renderer/stats/format-duration.ts`：

```ts
/** 秒 → 人读时长，单位标签经调用方注入（i18n）。0/负 → "0{m}"；整点省略分钟。 */
export function formatDuration(totalSeconds: number, hLabel: string, mLabel: string): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}${mLabel}`;
  if (minutes === 0) return `${hours}${hLabel}`;
  return `${hours}${hLabel} ${minutes}${mLabel}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/stats/format-duration.test.ts`
Expected: PASS（5 个）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stats/format-duration.ts src/renderer/stats/format-duration.test.ts
git commit -m "feat(stats): add formatDuration util"
```

---

## Task 15: 统计页 UI（StatsView + 子组件 + query key）

**Files:**

- Modify: `src/renderer/query/keys.ts`, `src/renderer/stats/StatsView.tsx`
- Create: `src/renderer/stats/StatOverview.tsx`, `DailyBarChart.tsx`, `StreakCard.tsx`, `BookRanking.tsx`

- [ ] **Step 1: 加 query key**

在 `src/renderer/query/keys.ts` 的 `qk` 对象内加一行（`recentlyRead` 附近）：

```ts
  stats: (dailyDays: number) => ["stats", dailyDays] as const,
```

- [ ] **Step 2: StatOverview**

`src/renderer/stats/StatOverview.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { formatDuration } from "@renderer/stats/format-duration";

export function StatOverview({
  totalSeconds,
  todaySeconds,
  weekSeconds,
}: {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number;
}) {
  const { t } = useTranslation();
  const h = t("stats.unitHour", "h");
  const m = t("stats.unitMin", "m");
  const cell = (label: string, seconds: number) => (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-3xl font-bold tabular-nums">{formatDuration(seconds, h, m)}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 gap-4">
      {cell(t("stats.total", "总时长"), totalSeconds)}
      {cell(t("stats.today", "今日"), todaySeconds)}
      {cell(t("stats.week", "近 7 天"), weekSeconds)}
    </div>
  );
}
```

- [ ] **Step 3: DailyBarChart**

`src/renderer/stats/DailyBarChart.tsx`（bar 高度是运行时计算值，允许内联 style）：

```tsx
import { useTranslation } from "react-i18next";
import type { DailyPoint } from "@shared/stats";

export function DailyBarChart({ daily }: { daily: DailyPoint[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...daily.map((d) => d.seconds));
  const first = daily[0]?.day ?? "";
  const last = daily[daily.length - 1]?.day ?? "";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold">{t("stats.dailyTitle", "每日时长")}</div>
      <div className="flex h-28 items-end gap-1">
        {daily.map((d) => (
          <div
            key={d.day}
            title={d.day}
            className={
              d.seconds > 0 ? "flex-1 rounded-t bg-primary/80" : "flex-1 rounded-t bg-muted"
            }
            style={{ height: `${Math.max(2, (d.seconds / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: StreakCard**

`src/renderer/stats/StreakCard.tsx`：

```tsx
import { useTranslation } from "react-i18next";

export function StreakCard({
  currentStreak,
  longestStreak,
  readingDays,
}: {
  currentStreak: number;
  longestStreak: number;
  readingDays: number;
}) {
  const { t } = useTranslation();
  const block = (label: string, value: number) => (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">
        {t("stats.daysValue", "{{count}} 天", { count: value })}
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-7 rounded-xl border border-border bg-card p-4">
      <span className="text-3xl">🔥</span>
      {block(t("stats.currentStreak", "当前连续"), currentStreak)}
      {block(t("stats.longestStreak", "历史最长"), longestStreak)}
      <div className="ms-auto text-right">
        {block(t("stats.readingDays", "累计阅读"), readingDays)}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: BookRanking**

`src/renderer/stats/BookRanking.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import type { BookReadingTotal } from "@shared/stats";
import { formatDuration } from "@renderer/stats/format-duration";

export function BookRanking({ perBook }: { perBook: BookReadingTotal[] }) {
  const { t } = useTranslation();
  const h = t("stats.unitHour", "h");
  const m = t("stats.unitMin", "m");
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-sm font-semibold">{t("stats.ranking", "各书时长排行")}</div>
      <ul>
        {perBook.map((b, i) => (
          <li
            key={b.bookId}
            className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 border-b border-border/60 py-2 last:border-0"
          >
            <span className="text-center text-sm font-semibold text-muted-foreground">{i + 1}</span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {b.title ?? t("library.untitled", "未命名")}
              </div>
              {b.author && <div className="truncate text-xs text-muted-foreground">{b.author}</div>}
            </div>
            <span className="text-sm font-semibold tabular-nums">
              {formatDuration(b.seconds, h, m)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 6: StatsView 容器（替换占位）**

`src/renderer/stats/StatsView.tsx`：

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { StatOverview } from "@renderer/stats/StatOverview";
import { DailyBarChart } from "@renderer/stats/DailyBarChart";
import { StreakCard } from "@renderer/stats/StreakCard";
import { BookRanking } from "@renderer/stats/BookRanking";

const DAILY_DAYS = 30;

export function StatsView() {
  const { t } = useTranslation();
  // staleTime:0 + refetchOnMount：查看统计页时不在 reader、不再累计，切到该 tab 取最新即可，无需轮询。
  const stats = useQuery({
    queryKey: qk.stats(DAILY_DAYS),
    queryFn: () => window.api.stats.get({ dailyDays: DAILY_DAYS }),
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (stats.isPending) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{t("stats.loading", "加载统计…")}</div>
    );
  }
  if (stats.isError || !stats.data) {
    return (
      <div className="p-6 text-sm text-destructive">{t("stats.loadError", "读取统计失败")}</div>
    );
  }
  const d = stats.data;
  if (d.totalSeconds === 0) {
    return (
      <div className="mt-20 text-center text-sm text-muted-foreground">
        {t("stats.empty", "开始阅读后，这里会出现你的阅读统计。")}
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <StatOverview
          totalSeconds={d.totalSeconds}
          todaySeconds={d.todaySeconds}
          weekSeconds={d.weekSeconds}
        />
        <DailyBarChart daily={d.daily} />
        <StreakCard
          currentStreak={d.currentStreak}
          longestStreak={d.longestStreak}
          readingDays={d.readingDays}
        />
        {d.perBook.length > 0 && <BookRanking perBook={d.perBook} />}
      </div>
    </ScrollArea>
  );
}
```

- [ ] **Step 7: typecheck**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/query/keys.ts src/renderer/stats
git commit -m "feat(stats): build stats page UI"
```

---

## Task 16: i18n（extract + 补 en）

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`, `src/shared/i18n/locales/en.ts`

- [ ] **Step 1: 抽取同步主语言**

Run: `pnpm i18n:extract`
Expected: `zh-CN.ts` 新增本计划引入的键（`shell.tabLibrary`/`shell.tabStats`/`stats.*`/`library.count`），值取 t() 内联中文默认。

- [ ] **Step 2: 补 en 译文**

打开 `src/shared/i18n/locales/en.ts`，为新键补英文（与 zh-CN 同键、英文值）。逐键对照：

```ts
  "shell.tabLibrary": "Library",
  "shell.tabStats": "Stats",
  "stats.total": "Total",
  "stats.today": "Today",
  "stats.week": "Last 7 days",
  "stats.unitHour": "h",
  "stats.unitMin": "m",
  "stats.dailyTitle": "Daily reading",
  "stats.currentStreak": "Current streak",
  "stats.longestStreak": "Longest streak",
  "stats.readingDays": "Days read",
  "stats.daysValue": "{{count}} d",
  "stats.ranking": "Time by book",
  "stats.loading": "Loading stats…",
  "stats.loadError": "Failed to load stats",
  "stats.empty": "Your reading stats will appear here once you start reading.",
  "library.count": "{{count}} books",
```

> 注意 [[i18n-operational-gotchas]]：键插入位置须保持 `sort:true` 字母序；`library.untitled` 若已存在勿重复加。改完用 grep 复核键存在（`i18n:lint` 可能漏报）。

- [ ] **Step 3: 校验**

Run: `pnpm i18n:lint && pnpm typecheck`
Expected: 无缺漏键；typecheck 通过。再 grep 复核：

Run: `grep -c "stats.total" src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts`
Expected: 两文件各 1。

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales
git commit -m "i18n: add reading-stats and shell-tab keys"
```

---

## Task 17: 全量验证 + dev 冒烟 + changeset

**Files:**

- Create: changeset 文件（`pnpm changeset` 生成）

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿。新增测试文件全 PASS。

- [ ] **Step 2: dev 冒烟（手动观察）**

Run: `pnpm start`（阻塞；用 dev userData，见 [[dev-prod-data-isolation]]）
检查清单：

1. 启动落在「书库」tab；顶栏见居中 pill `( 书库 | 统计 )` + 右侧 ⚙；书库内容区顶部见「共 N 本 / 导入书籍」按钮。
2. 开一本书 → reader 全屏、**无 pill 标签条**；读 ≥ 1 分钟（或等一个 flush 周期）。
3. 返回书库 → 点「统计」tab → 见今日时长 > 0、每日柱图当天有值。
4. 切到别的 app 停一会再回来 → 时长不应在失焦期间增长（粗验：失焦前后 today 秒数差 ≈ 失焦前的累计）。
5. 切回「书库」tab → 导入按钮可用、拖拽导入仍工作。
6. （可选）删一本读过的书 → 统计页 total / streak 不变，各书排行不再列它。

Ctrl-C 结束。如发现 bug，回到对应任务修正并补测试。

- [ ] **Step 3: 写 changeset**

Run: `pnpm changeset`
选 patch/minor（本功能为新增 → minor），写一条用户向英文条目，例如：

```
Add reading-time tracking with a dedicated Stats tab: total/today/last-7-days, a daily reading chart, reading streaks, and per-book time ranking. Navigation now uses Apple Books-style top pill tabs (Library / Stats).
```

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for reading-time tracking (#73)"
```

---

## Self-Review 记录（writing-plans 自审）

- **Spec 覆盖**：§1 导航重构 → Task 9–12；§2 数据模型 → Task 1；§3 时钟/聚合/仓储 → Task 3–7；§4 IPC 契约 → Task 2、8；§5 渲染层 → Task 13–15；§6 i18n → Task 16；§7 测试 → 随各任务 TDD + Task 17；§8 迁移/验证 → Task 1、17。无遗漏。
- **类型一致**：`commit(bookId, atMs, seconds)` 在 clock/clock-wiring 一致；`aggregateStats` 返回 `Omit<ReadingStatsDto,"perBook">`、handler 合并 `perBook`；`DailyPoint`/`BookReadingTotal`/`ReadingStatsDto` 单一源在 `@shared/stats`，main 与 renderer 共用。
- **占位符**：无 TBD/TODO；每个代码步给全量代码。
- **已知顺序依赖**：Task 11 引 `StatsView`（先占位）→ Task 15 补全；Task 10 ShellHeader 依赖 Task 9 的 store actions。
