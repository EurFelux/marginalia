# 全书摘要（M-d `books.summary`）· 设计文档

> 状态：用户 2026-06-03 指定「下一个做全书摘要」+ 拍板生成策略「**直接喂整本书**」。镜像现有章节摘要基建（`ensureChapterSummary`）。查看处：**侧栏书卡**（产品决策记忆 `global-summary-and-viewing`）。

## 1. 背景

章节摘要已成（`chapters.summary`/`summaryStatus` + `ensureChapterSummary` 懒生成 + `SummaryPill` 查看）。全书摘要为 M-d，覆盖**主题/人物/结构**，在侧栏书卡查看。生成策略用户定为「直接喂整本书」——把全书正文（截断到预算）一次性喂模型，单次 `generateText`，**不**走章节组合/map-reduce。触发：**按需**（书卡「生成」按钮，与章节 pill 一致；合「默认不自动生成、控成本」理念——整本喂是大输入调用，不宜每本导入即烧）。

## 2. 设计（镜像章节摘要）

### 2.1 DB（`src/main/db/schema.ts` books）

```ts
summary: text("summary"),
summaryStatus: text("summary_status", { enum: ["pending", "generating", "ready", "unavailable"] })
  .notNull().default("pending"),
// + CHECK books_summary_status_check（同 chapters）
```

`pnpm db:generate` → **ALTER TABLE ADD COLUMN ×2**（加列，非表重建 → 不触发 FK 事务坑）。注意 CHECK 约束在加列迁移里的生成——核验产物。

### 2.2 取全书正文（`src/main/library/content.ts`）

```ts
export function readBookText(
  db,
  bytes,
  bookId,
  opts: { maxChars: number },
): { text: string; truncated: boolean };
```

按 `orderIndex` 升序遍历**所有 spine 章节**（非仅 TOC——全书覆盖），逐章 `extractChapterText(bytes, href, { maxChars: 剩余预算 })` 拼接（章间 `\n\n`），累计到 `maxChars` 截断。`BOOK_SUMMARY_INPUT_MAX_CHARS` 取较大值（如 180_000；CJK 最坏 ≈ token 数，留 system+output 余量适配 200k 上下文的摘要模型；超长书前载截断——仍覆盖开篇/主线/主要人物）。

`getBookSummary(db, bookId): { status, summary }`（镜像 `getChapterSummary`，读 books 行）。

### 2.3 生成（`src/main/ai/summary.ts` 加 `ensureBookSummary`）

镜像 `ensureChapterSummary`，差异：

- 主体 keyed by `bookId`（独立 `inFlight` set 或复用同一 set 加前缀，避免与章节 id 撞）；
- `BOOK_SUMMARY_SYSTEM`：「概括整本书，覆盖核心主题、主要人物、结构脉络；忠实、数段、仅输出摘要」；
- 输入 = `readBookText(db, bytes, bookId, { maxChars: BOOK_SUMMARY_INPUT_MAX_CHARS }).text`；
- `maxOutputTokens` 适当放大（如 1024，全书摘要比单章长）；
- 状态机同章节：仅从 `pending` 起、`inFlight` 并发去重、`resolveModel` 未配置则保持 pending、同步前缀置 `generating`（使 handler 即时返回 generating）、成功 `ready`、异常 `unavailable`、自含 reject。

`resetStuckSummaries(db)` 扩展：把 books 的 `generating`→`pending`（与 chapters 一并，启动 `initDb` 时复位）。

### 2.4 IPC / DTO / preload

- 通道：`contentBookSummary: "content:book-summary"`（get，`bookIdInput` → `BookSummaryContentDto`）、`contentGenerateBookSummary: "content:generate-book-summary"`（触发，`bookIdInput` → `BookSummaryContentDto`）。
- `src/shared/library.ts`：`export interface BookSummaryContentDto { status: SummaryStatus; summary: string | null }`。
- `library-handlers.ts`：两 handler 镜像章节版（generate 版 fire-and-forget `ensureBookSummary(makeSummaryDeps(), bookId)` + 返回 `getBookSummary`）。
- `preload.ts`：`content.bookSummary(input)` / `content.generateBookSummary(input)`。

### 2.5 UI（侧栏书卡）

`Sidebar` 现为 目录/标注 Tabs；在其**上方**加一个轻量 **BookCard**：显示书名/作者 + 全书摘要状态徽标，点开 Popover（镜像 `SummaryPill`）看摘要正文 + 「生成摘要」按钮（`pending`/`unavailable` 时显示）；`pending`/`generating` 时轮询 `content.bookSummary`。书名/作者取 `window.api.library.get({bookId})`。复用 shadcn `Popover` + `Button` + 现有 BADGE 状态映射（可从 `SummaryPill` 提取共享 `SUMMARY_BADGE`）。

## 3. 测试（headless）

- `content.test.ts`：`readBookText` 按序拼接多章、到 `maxChars` 截断（`truncated:true`）；`getBookSummary` 往返/未生成 pending。
- `summary.test.ts`：`ensureBookSummary` pending→ready（mock model）；ready 则跳过（不重生）；模型未配置保持 pending；异常→unavailable；`resetStuckSummaries` 复位 books 的 generating。
- 回归：现 192 测试不破 + 新增全绿；typecheck/lint 绿。

## 4. 非目标

- 导入时自动生成（按需触发；可后续加「导入后台预生成」开关）。
- 超长书的分块/map-reduce（用户选「直接喂」+ 高位截断；超大书前载截断已够 best-effort）。
- 跨章组合摘要（独立 backlog，ma4-deferred #8）。
