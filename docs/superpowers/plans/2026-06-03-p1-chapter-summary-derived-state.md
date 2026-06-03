# P1 · 章节摘要派生态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把章节摘要状态从持久化的 `chapters.summary_status` 列改为进程内派生态，镜像全书摘要已验证的模式，并删除崩溃复位补丁 `resetStuckSummaries`。

**Architecture:** 状态不再入库——`summary.ts` 持有两个进程内 `Set`（`inFlightChapters` / `failedChapters`），`getChapterSummaryView` 在读取时由 `chapters.summary` 正文 + 两集派生 `{ status, summary }`（`inFlight`→generating ／ `summary!=null`→ready ／ `failed`→unavailable ／ else pending）。因 `summary.ts` 已 `import` `content.ts`，派生函数必须落在 `summary.ts`（避免循环依赖），故所有消费方（`send.ts`、`tools.ts`、`library-handlers.ts`）改从 `summary.ts` 导入新函数。分两步：**Task 1** 切换读写路径（`summary_status` 列暂留、变为废列，全程绿）；**Task 2** 删废列 + 重新生成迁移。

**Tech Stack:** TypeScript 6、Drizzle ORM 1.0-rc（better-sqlite3）、Vitest 4（Electron 运行时）、Vercel AI SDK v6。设计依据：`docs/superpowers/specs/2026-06-03-db-lifecycle-rules-design.md` §2 / DD-§2。

**契约不变：** `getChapterSummaryView` 返回形状 `{ status, summary }` 与旧 `getChapterSummary` 完全一致，IPC 通道（`content:chapter-summary` / `content:generate-chapter-summary`）与 renderer（`SummaryPill`、`ReaderView` 自动摘要）**零改动**。

**新增的可观察行为：** ①失败章节在下次触发时**自动重试**（`ensureChapterSummary` 开头 `failedChapters.delete`，不再卡在 `unavailable`）；②重启后进程内集清空 → `generating`/`failed` 自然消失，无需 `resetStuckSummaries`。

---

## File Structure

| 文件                                  | 责任                                                                | Task |
| ------------------------------------- | ------------------------------------------------------------------- | ---- |
| `src/main/ai/summary.ts`              | 章节摘要生成 + **派生读** + 运行时集（新主场）                      | 1    |
| `src/main/library/content.ts`         | 删除 `getChapterSummary` + `ChapterSummary` 接口（迁往 summary.ts） | 1    |
| `src/main/ai/send.ts`                 | 改用 `getChapterSummaryView`                                        | 1    |
| `src/main/ai/tools.ts`                | AI 工具改用 `getChapterSummaryView`                                 | 1    |
| `src/main/ipc/library-handlers.ts`    | 改用 `getChapterSummaryView` + `ChapterSummaryDto`                  | 1    |
| `src/main/db/instance.ts`             | 删除 `resetStuckSummaries` 导入与调用                               | 1    |
| `src/main/ai/summary.test.ts`         | 重写章节测试（派生断言）、删 `resetStuckSummaries` 测试             | 1    |
| `src/main/library/content.test.ts`    | 删 `getChapterSummary` 两用例                                       | 1    |
| `src/main/db/schema.ts`               | 删 `summaryStatus` 列 + CHECK                                       | 2    |
| `src/main/library/repository.ts`      | 导入插入去掉 `summaryStatus: "pending"`                             | 2    |
| `src/shared/library.ts`               | 更新 `SummaryStatus` 的过时注释                                     | 2    |
| `src/main/db/migrations/<new>/`       | `pnpm db:generate` 生成的删列迁移                                   | 2    |
| `src/main/library/repository.test.ts` | 删 `summaryStatus` 断言                                             | 2    |
| `src/main/ai/send.test.ts`            | fixture 改设 `summary`（去 `summaryStatus`）                        | 2    |

> **说明：refactor 性质的 TDD。** 本计划是契约保持的重构，多文件须一起改才能编译，无法逐文件跑「先失败再通过」。每个 Task 内：先改实现与测试，再 `pnpm test`/`pnpm typecheck` 验证全绿，最后提交。每个 Task 结束都是一个可编译、测试全绿的提交点。

---

## Task 1: 切换章节摘要到派生态读写路径

**Files:**

- Modify: `src/main/ai/summary.ts`
- Modify: `src/main/library/content.ts`
- Modify: `src/main/ai/send.ts`
- Modify: `src/main/ai/tools.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/main/db/instance.ts`
- Test: `src/main/ai/summary.test.ts`
- Test: `src/main/library/content.test.ts`

- [ ] **Step 1: 重写 `summary.ts` 章节段——内存集 + 派生读 + 新 `ensureChapterSummary`**

把 `src/main/ai/summary.ts` 中**从 `const inFlight` 到 `ensureChapterSummary` 结束**（当前第 22–81 行）整段替换为下面内容：

```ts
// 章节摘要的进程内运行时状态（不持久化；重启清空，镜像全书摘要）：
// summary!=null=ready，inFlightChapters=generating，failedChapters=unavailable，否则 pending。
const inFlightChapters = new Set<string>();
const failedChapters = new Set<string>();

/**
 * 读某章摘要正文 + 派生状态（状态不入 DB，镜像 getBookSummaryView）。
 * 章节摘要非流式，故 generating 无 partial（summary: null）。
 */
export function getChapterSummaryView(
  db: DB,
  bookId: string,
  chapterId: string,
): { status: SummaryStatus; summary: string | null } {
  const row = db
    .select({ summary: chapters.summary })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`summary: chapter ${chapterId} not found in book ${bookId}`);
  if (inFlightChapters.has(chapterId)) return { status: "generating", summary: null };
  const summary = row.summary ?? null;
  const status: SummaryStatus =
    summary != null ? "ready" : failedChapters.has(chapterId) ? "unavailable" : "pending";
  return { status, summary };
}

/** 仅供测试：清空章节摘要的进程内运行时态，保证用例隔离（chapter.id 由 fixture 确定、跨用例相同）。 */
export function __resetChapterSummaryRuntime(): void {
  inFlightChapters.clear();
  failedChapters.clear();
}

/**
 * 懒生成某章摘要（设计文档 §11；状态派生，不入 DB）。非阻塞调用方 fire-and-forget。
 * 失败章节下次触发会自动重试（开头清 failedChapters），重启后进程内集清空亦自愈——故无需 resetStuckSummaries。
 */
export async function ensureChapterSummary(
  deps: SummaryDeps,
  bookId: string,
  chapterId: string,
): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;
  let claimed = false;
  try {
    if (inFlightChapters.has(chapterId)) return; // 并发去重
    const stored = db
      .select({ summary: chapters.summary })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .get();
    if (!stored) return; // 章不存在
    if (stored.summary != null) return; // 已 ready，跳过
    const resolved = resolveModel();
    if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

    failedChapters.delete(chapterId); // 清前次失败标记 → 可重试
    inFlightChapters.add(chapterId); // 同步前缀：使 generate handler 即时派生 generating
    claimed = true;
    const bytes = await loadBytes(bookId);
    const slice = readChapterText(db, bytes, bookId, chapterId, {
      maxChars: SUMMARY_INPUT_MAX_CHARS,
    });
    const { text } = await generateText({
      model: resolved.model,
      system: SUMMARY_SYSTEM,
      prompt: slice.text,
      maxOutputTokens: 512,
      maxRetries: 1,
    });
    db.update(chapters).set({ summary: text }).where(eq(chapters.id, chapterId)).run();
  } catch (err) {
    // 自含全部 reject（fire-and-forget 端口为 => void）。已 claim 的标记 failed（派生 unavailable）。
    console.warn(`[summary] chapter ${chapterId} ensure failed:`, err);
    if (claimed) failedChapters.add(chapterId);
  } finally {
    if (claimed) inFlightChapters.delete(chapterId);
  }
}
```

- [ ] **Step 2: 删除 `summary.ts` 末尾的 `resetStuckSummaries`**

删除 `src/main/ai/summary.ts` 文件末尾整个 `resetStuckSummaries` 函数及其上方注释块（当前第 180–190 行）：

```ts
/**
 * 启动恢复：把上次进程崩溃残留的 "generating" 复位为 "pending"，否则该章摘要因 pending-check
 * 永不重试。应用启动（initDb）时调用一次。inFlight 是进程内态，重启即清空，故只需复位 DB。
 * 注：全书摘要无需此复位——其状态本就运行时派生，重启时 inFlightBooks 自然为空。
 */
export function resetStuckSummaries(db: DB): void {
  db.update(chapters)
    .set({ summaryStatus: "pending" })
    .where(eq(chapters.summaryStatus, "generating"))
    .run();
}
```

删除后文件应无任何 `summaryStatus` 引用（Step 1 已去除）。

- [ ] **Step 3: `content.ts` 删除 `getChapterSummary` 与 `ChapterSummary` 接口**

在 `src/main/library/content.ts`：删除 `ChapterSummary` 接口（当前第 9–12 行）：

```ts
export interface ChapterSummary {
  status: "pending" | "generating" | "ready" | "unavailable";
  summary: string | null;
}
```

并删除 `getChapterSummary` 函数（当前第 23–31 行）：

```ts
export function getChapterSummary(db: DB, bookId: string, chapterId: string): ChapterSummary {
  const row = db
    .select({ summary: chapters.summary, status: chapters.summaryStatus })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return { status: row.status, summary: row.summary ?? null };
}
```

`content.ts` 其余导入（`and`/`eq`/`chapters`）仍被 `readChapterText` 等使用，保留不动。

- [ ] **Step 4: `send.ts` 改用 `getChapterSummaryView`**

`src/main/ai/send.ts` 第 7 行：

```ts
import { getChapterSummary } from "@main/library/content";
```

替换为：

```ts
import { getChapterSummaryView } from "@main/ai/summary";
```

第 89 行：

```ts
const summary = getChapterSummary(db, input.bookId, input.currentChapterId);
```

替换为：

```ts
const summary = getChapterSummaryView(db, input.bookId, input.currentChapterId);
```

（第 61 行注释里提及的 `getChapterSummary` 是历史说明，可顺手改为 `getChapterSummaryView`，非必须。）

- [ ] **Step 5: `tools.ts` 的 AI 工具改用 `getChapterSummaryView`**

`src/main/ai/tools.ts` 第 7 行：

```ts
import { getChapterSummary, listChapters, readChapterText } from "@main/library/content";
```

替换为（拆成两行——`getChapterSummaryView` 来自 summary.ts；`summary.ts` 对 `tools.ts` 仅 `import type { LoadBytes }`，类型导入运行时擦除，无循环）：

```ts
import { listChapters, readChapterText } from "@main/library/content";
import { getChapterSummaryView } from "@main/ai/summary";
```

第 49–50 行的 `execute`：

```ts
      execute: async ({ chapterId }) =>
        getChapterSummary(db, bookId, resolveChapterRef(db, bookId, chapterId)),
```

替换为（工具名 `getChapterSummary` 对模型暴露不变，仅内部实现改）：

```ts
      execute: async ({ chapterId }) =>
        getChapterSummaryView(db, bookId, resolveChapterRef(db, bookId, chapterId)),
```

- [ ] **Step 6: `library-handlers.ts` 改用 `getChapterSummaryView` + `ChapterSummaryDto`**

`src/main/ipc/library-handlers.ts` 的 `@shared/library` 导入块（当前第 5–15 行）补入 `ChapterSummaryDto`：

```ts
import {
  bookIdInput,
  chapterRefInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  type BookSummaryContentDto,
  type BookSummaryDto,
  type ChapterRefDto,
  type ChapterSummaryDto,
  type ChapterTextSlice,
} from "@shared/library";
```

`@main/library/content` 导入块（当前第 21–27 行）去掉 `getChapterSummary` 与 `type ChapterSummary`：

```ts
import { getToc, listChapters, readChapterText } from "@main/library/content";
```

`@main/ai/summary` 导入（当前第 28 行）补入 `getChapterSummaryView`：

```ts
import {
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  getChapterSummaryView,
} from "@main/ai/summary";
```

两个 handler（当前第 102–120 行）整体替换为：

```ts
handle<{ bookId: string; chapterId: string }, ChapterSummaryDto>(
  IPC.contentChapterSummary,
  chapterRefInput,
  (input) => getChapterSummaryView(getDb(), input.bookId, input.chapterId),
);

// 触发本章摘要懒生成（开章自动 / pill 手动按钮）。fire-and-forget：ensureChapterSummary
// 内部自含 reject 兜底；同步前缀会把状态派生为 generating，故返回当前派生状态即时反馈。
handle<{ bookId: string; chapterId: string }, ChapterSummaryDto>(
  IPC.contentGenerateChapterSummary,
  chapterRefInput,
  (input) => {
    const db = getDb();
    void ensureChapterSummary(makeSummaryDeps(), input.bookId, input.chapterId).catch((err) =>
      console.warn("[content] generate chapter summary failed:", err),
    );
    return getChapterSummaryView(db, input.bookId, input.chapterId);
  },
);
```

- [ ] **Step 7: `instance.ts` 删除 `resetStuckSummaries`**

`src/main/db/instance.ts` 删除第 4 行导入：

```ts
import { resetStuckSummaries } from "@main/ai/summary";
```

删除第 21 行调用：

```ts
resetStuckSummaries(candidate); // 复位上次崩溃残留的 "generating" 章节摘要
```

- [ ] **Step 8: 重写 `summary.test.ts` 章节测试为派生断言**

`src/main/ai/summary.test.ts`：导入块（当前第 12–19 行）改为（去 `resetStuckSummaries`，加 `getChapterSummaryView` + `__resetChapterSummaryRuntime`）：

```ts
import {
  __resetBookSummaryRuntime,
  __resetChapterSummaryRuntime,
  ensureBookSummary,
  ensureChapterSummary,
  getBookSummaryView,
  getChapterSummaryView,
  type SummaryDeps,
} from "@main/ai/summary";
```

删除 `statusOf` helper（当前第 76–78 行，章节测试改用派生视图断言，不再直读列）：

```ts
function statusOf(db: ReturnType<typeof createDb>, chapterId: string) {
  return db.select().from(chapters).where(eq(chapters.id, chapterId)).get()!;
}
```

把 `describe("ensureChapterSummary", ...)`（当前第 80–119 行）与 `describe("resetStuckSummaries", ...)`（当前第 121–140 行）**两段整体替换**为：

```ts
describe("ensureChapterSummary / getChapterSummaryView (derived status)", () => {
  // chapter.id 由 fixture 确定、跨用例相同 → 清进程内运行时集保证隔离。
  beforeEach(() => __resetChapterSummaryRuntime());

  it("derives pending for a fresh chapter with no summary", () => {
    const { db, book, ch1, deps: _deps } = setup({ ok: false, reason: "x" });
    void _deps;
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "pending",
      summary: null,
    });
  });

  it("throws for an unknown chapterId", () => {
    const { db, book } = setup({ ok: false, reason: "x" });
    expect(() => getChapterSummaryView(db, book.id, "nonexistent-id")).toThrow(/not found/);
  });

  it("generates and stores the summary, deriving ready", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: genModel("A concise summary."),
      modelId: "mock",
    });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id)).toEqual({
      status: "ready",
      summary: "A concise summary.",
    });
  });

  it("is a no-op when the summary already exists", async () => {
    const { db, book, ch1, deps } = setup({ ok: true, model: genModel("new"), modelId: "mock" });
    db.update(chapters).set({ summary: "cached" }).where(eq(chapters.id, ch1.id)).run();
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).summary).toBe("cached"); // unchanged
  });

  it("derives unavailable when generation throws", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("unavailable");
  });

  it("stays pending when no model is configured", async () => {
    const { db, book, ch1, deps } = setup({ ok: false, reason: "not configured" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("pending");
  });

  it("restart semantics: clearing runtime vanishes generating/failed; stored summary still derives ready", async () => {
    const failModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    await ensureChapterSummary(deps, book.id, ch1.id);
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("unavailable");
    __resetChapterSummaryRuntime(); // 模拟重启：进程内集清空
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("pending"); // failed 消失 → 可重试
    db.update(chapters).set({ summary: "S" }).where(eq(chapters.id, ch1.id)).run();
    expect(getChapterSummaryView(db, book.id, ch1.id).status).toBe("ready"); // summary 在 → ready
  });
});
```

- [ ] **Step 9: `content.test.ts` 删除两个 `getChapterSummary` 用例**

`src/main/library/content.test.ts` 导入块（当前第 6–12 行）去掉 `getChapterSummary`：

```ts
import { getToc, listChapters, readBookText, readChapterText } from "@main/library/content";
```

删除两个用例（当前第 39–48 行）：

```ts
it("getChapterSummary returns pending by default", () => {
  const { db, book } = setup();
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  expect(getChapterSummary(db, book.id, ch1.id)).toEqual({ status: "pending", summary: null });
});

it("getChapterSummary throws for an unknown chapterId", () => {
  const { db, book } = setup();
  expect(() => getChapterSummary(db, book.id, "nonexistent-id")).toThrow(/not found/);
});
```

（其等价覆盖已在 Step 8 的 `getChapterSummaryView` 两用例中。content.test.ts:82 的 `summaryStatus: "pending"` fixture 暂留——列还在，Task 2 再清。）

- [ ] **Step 10: 跑受影响测试 + 全量类型检查**

Run: `pnpm test src/main/ai/summary.test.ts src/main/library/content.test.ts src/main/ai/tools.test.ts src/main/ai/send.test.ts`
Expected: PASS（全绿。`tools.test.ts`/`send.test.ts` 未改动也应通过：工具默认派生 `pending`；send fixture 同时 set 了 `summary` 故派生 `ready`、注入成功）

Run: `pnpm typecheck`
Expected: 无错误（所有 `getChapterSummary` 消费方已迁移；`summary_status` 列仍存于 schema，仅 `repository.ts` 插入处使用，合法）

- [ ] **Step 11: 提交**

```bash
git add src/main/ai/summary.ts src/main/library/content.ts src/main/ai/send.ts src/main/ai/tools.ts src/main/ipc/library-handlers.ts src/main/db/instance.ts src/main/ai/summary.test.ts src/main/library/content.test.ts
git commit -m "refactor(summary): derive chapter summary status from in-memory sets (#9 P1)

去 chapters.summary_status 的读写路径，改为镜像全书摘要的派生态
（inFlightChapters/failedChapters 内存集 + getChapterSummaryView）。
删除 resetStuckSummaries。summary_status 列暂留待 Task 2 删除。
契约 { status, summary } 与 IPC/renderer 不变。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 若 prek 钩子以「files were modified by this hook」中止（lint:fix/format 改了暂存文件），重新 `git add` 上述文件再执行同一 `git commit` 即可（第二次通过）。

---

## Task 2: 删除废弃的 `chapters.summary_status` 列

**Files:**

- Modify: `src/main/db/schema.ts`
- Modify: `src/main/library/repository.ts`
- Modify: `src/shared/library.ts`
- Modify: `src/main/library/content.test.ts`
- Modify: `src/main/library/repository.test.ts`
- Modify: `src/main/ai/send.test.ts`
- Create: `src/main/db/migrations/<auto-generated>/`（由 `pnpm db:generate`）

- [ ] **Step 1: `schema.ts` 删除 `summaryStatus` 列与 CHECK**

`src/main/db/schema.ts` 的 `chapters` 表：删除 `summaryStatus` 列定义（当前第 78–82 行）：

```ts
    summaryStatus: text("summary_status", {
      enum: ["pending", "generating", "ready", "unavailable"],
    })
      .notNull()
      .default("pending"),
```

并删除约束数组里的 CHECK（当前第 86–89 行）：

```ts
    check(
      "chapters_summary_status_check",
      sql`${t.summaryStatus} in ('pending','generating','ready','unavailable')`,
    ),
```

删除后 `chapters` 表约束数组应仅剩 `unique().on(t.bookId, t.href)` 与 `index("chapters_book_id_idx").on(t.bookId)`。`summary: text("summary")` 列**保留**（正文是耐久事实）。

> 检查：删 CHECK 后 `chapters` 表回调里若不再使用 `check`/`sql`，确认它们在文件别处仍被 `providers`/`messages` 等使用（仍 import，无需动 import）。

- [ ] **Step 2: `repository.ts` 导入插入去掉 `summaryStatus`**

`src/main/library/repository.ts` 章节插入（当前第 45–53 行）去掉 `summaryStatus: "pending",` 一行：

```ts
tx.insert(chapters)
  .values({
    bookId: id,
    href: item.href,
    orderIndex: index,
    title: labels.get(item.href) ?? null,
  })
  .run();
```

- [ ] **Step 3: `shared/library.ts` 更新过时注释**

`src/shared/library.ts` 第 50 行注释由：

```ts
/** 章节摘要状态机（与 chapters.summary_status 的 CHECK 约束一致）。 */
```

改为：

```ts
/** 章节/全书摘要的派生状态机（主进程读取时派生，不入 DB；见 DB lifecycle spec §2 / DD-§2）。 */
```

- [ ] **Step 4: 清理测试里残留的 `summaryStatus`**

`src/main/library/content.test.ts` 的 `listChapters` fixture（当前第 77–84 行）去掉 `summaryStatus: "pending",`：

```ts
db.insert(chapters)
  .values({
    bookId: book.id,
    href: "OEBPS/cover.xhtml",
    orderIndex: 99,
  })
  .run();
```

`src/main/library/repository.test.ts` 删除第 29 行断言：

```ts
expect(ch1?.summaryStatus).toBe("pending");
```

`src/main/ai/send.test.ts` 的 fixture（当前第 188–191 行）改为只设 `summary`（派生 ready）：

```ts
db.update(chapters).set({ summary: "CHAPTER-SUMMARY-XYZ" }).where(eq(chapters.id, ch1.id)).run();
```

- [ ] **Step 5: 生成删列迁移**

Run: `pnpm db:generate`
Expected: 在 `src/main/db/migrations/` 下生成一个新子目录（`<timestamp>_<name>/`，含 `migration.sql` + `snapshot.json`）。因 `summary_status` 列被 CHECK 约束引用，SQLite 无法直接 `DROP COLUMN`，drizzle-kit 生成**表重建**（`CREATE TABLE __new_chapters`（无 summary_status）→ `INSERT … SELECT` 拷贝 → `DROP TABLE chapters` → `ALTER … RENAME`）。

- [ ] **Step 6: 核对生成的迁移 SQL**

Run: `git status --porcelain src/main/db/migrations/`（确认仅新增一个迁移目录）
打开新目录的 `migration.sql` 确认：新 `chapters` 表**无** `summary_status` 列与对应 CHECK、保留 `summary`/`UNIQUE(book_id,href)`/索引。表重建的 `DROP TABLE chapters` 由 `runMigrations`（`client.ts:28`）在事务外 `PRAGMA foreign_keys=OFF` 包裹，不会因 `conversations.chapter_id` 引用而报 `SQLITE_CONSTRAINT_FOREIGNKEY`（记忆 `drizzle-migrate-fk-transaction-gotcha`）。

- [ ] **Step 7: 跑全量测试 + 类型检查**

Run: `pnpm test`
Expected: PASS（迁移在每个 `:memory:` 测试库由 `runMigrations` 应用，删列后所有摘要测试仍绿；`repository.test.ts`/`content.test.ts`/`send.test.ts` 已去 `summaryStatus`）

Run: `pnpm typecheck`
Expected: 无错误（schema 无 `summaryStatus` 后，全仓应无任何 `chapters.summaryStatus` / `summaryStatus:` 引用）

Run: `git grep -n "summaryStatus\|summary_status" -- ':!src/main/db/migrations'`
Expected: 仅剩 `src/shared/library.ts` 的注释（若 Step 3 已改为不含 `summary_status`，则**零命中**）

- [ ] **Step 8: 提交**

```bash
git add src/main/db/schema.ts src/main/library/repository.ts src/shared/library.ts src/main/library/content.test.ts src/main/library/repository.test.ts src/main/ai/send.test.ts src/main/db/migrations/
git commit -m "refactor(db): drop vestigial chapters.summary_status column (#9 P1)

章节摘要状态已全面派生（Task 1），summary_status 列成废列，删除之
+ CHECK + 导入插入 + 表重建迁移。保留 summary 正文列。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec 覆盖（对照 spec §2 / DD-§2）：**

- 删 `summary_status` 列 + CHECK（表重建迁移）→ Task 2 Step 1/5。✅
- `inFlightChapters` / `failedChapters` 两内存集 + 新尝试清 failed → Task 1 Step 1。✅
- `getChapterSummaryView` 派生（inFlight→generating / summary→ready / failed→unavailable / else pending）→ Task 1 Step 1。✅
- `ensureChapterSummary` 去 DB status 写、只管内存集、门控 `summary==null && !inFlight` → Task 1 Step 1。✅
- 删 `resetStuckSummaries` + `instance.ts` 调用 → Task 1 Step 2/7。✅
- `__resetChapterSummaryRuntime()` + failed 派生 + 重启语义用例 → Task 1 Step 1/8。✅
- DTO `{ status, summary }` 不变、IPC/renderer 零改动 → 契约保持（handler 仅换实现/类型别名）。✅
- 维持非流式（`generateText`、512 token、无 partial map）→ Task 1 Step 1 保留 `generateText`，generating 返回 `summary: null`。✅

**2. 占位扫描：** 无 TBD/TODO/"类似上文"；每个改动均给出完整替换代码与精确行号锚点。唯一「自动生成」项是 Task 2 的迁移目录——这是 `pnpm db:generate` 的产物，计划给出预期 SQL 形状与核对步骤，非占位。✅

**3. 类型/命名一致性：** 全程统一 `getChapterSummaryView`（summary.ts 定义、send/tools/handlers 消费）、`__resetChapterSummaryRuntime`、`inFlightChapters`/`failedChapters`、`ChapterSummaryDto`（handler 类型）。返回形状 `{ status: SummaryStatus; summary: string | null }` 与旧 `ChapterSummary`/`ChapterSummaryDto` 一致。✅

**4. 循环依赖核查：** `tools.ts`→`summary.ts`（值）、`summary.ts`→`tools.ts`（`import type`，运行时擦除）；`send.ts`→`summary.ts`（值）、`summary.ts`→`content.ts`（值）、`content.ts` 不回引 → 无运行时环。✅
