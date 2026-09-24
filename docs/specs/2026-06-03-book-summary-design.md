# 全书摘要（M-d `books.summary`）· 设计文档

> 状态：用户 2026-06-03 指定「下一个做全书摘要」+ 拍板生成策略「**直接喂整本书**」。镜像现有章节摘要基建（`ensureChapterSummary`）。查看处：**侧栏书卡**（产品决策记忆 `global-summary-and-viewing`）。

## 1. 背景

章节摘要已成（`chapters.summary`/`summaryStatus` + `ensureChapterSummary` 懒生成 + `SummaryPill` 查看）。全书摘要为 M-d，覆盖**主题/人物/结构**，在侧栏书卡查看。生成策略用户定为「直接喂整本书」——把全书正文（截断到预算）一次性喂模型，单次 `generateText`，**不**走章节组合/map-reduce。触发：**按需**（书卡「生成」按钮，与章节 pill 一致；合「默认不自动生成、控成本」理念——整本喂是大输入调用，不宜每本导入即烧）。

## 2. 设计（镜像章节摘要）

### 2.1 DB（`src/main/db/schema.ts` books）

**只持久化 `summary` 正文**——状态是运行时派生，不入 DB（用户 2026-06-03 决策；持久化运行时态正是 chapters 那个 `resetStuckSummaries` 复位补丁的病根：进程崩在 `generating` 会永久卡住）。

```ts
summary: text("summary"), // 唯一持久化事实；无 summaryStatus 列、无 CHECK
```

`pnpm db:generate` → 纯 **`ALTER TABLE books ADD summary text`**（加列、不重建、不碰 FK 坑）。已生成 `20260603011333_nebulous_ezekiel`。

### 2.2 状态派生（`src/main/ai/summary.ts`，与运行时集同处）

`SummaryStatus`（renderer 契约不变）在**读取时派生**，源 = DB 的 `summary` 是否存在 + 进程内两个 Set：

```ts
// summary.ts 模块级
const inFlightBooks = new Set<string>(); //  正在生成（纯进程态，重启清空）
const failedBooks = new Set<string>(); //    本进程生成报错（重启清空 → 重启即可重试）

export function getBookSummaryView(db, bookId): { status: SummaryStatus; summary: string | null } {
  const summary = <读 books.summary> ?? null;
  const status = summary != null ? "ready"
    : inFlightBooks.has(bookId) ? "generating"
    : failedBooks.has(bookId) ? "unavailable"
    : "pending";
  return { status, summary };
}
```

派生函数与 `inFlightBooks`/`failedBooks` 同模块（需读这两个 Set），故放 `summary.ts` 而非 `content.ts`。**不需要 `resetStuckSummaries` for books**——重启时 `inFlightBooks` 自然为空，状态从 `summary` 正确派生。

### 2.3 取全书正文 + 生成（`content.ts` + `summary.ts`）

`content.ts` `readBookText(db, bytes, bookId, { maxChars }): { text; truncated }`：按 `orderIndex` 升序遍历**所有 spine 章节**（全书覆盖），逐章 `extractChapterText(bytes, href, { maxChars: 剩余预算 })` 拼接（章间 `\n\n`），累计到 `maxChars` 截断。`BOOK_SUMMARY_INPUT_MAX_CHARS ≈ 180_000`（适配 200k 上下文摘要模型，超长书前载截断）。

`summary.ts` `ensureBookSummary(deps, bookId)`：

- `getBookSummaryView` 已 `ready`（summary 非空）或 `inFlightBooks.has` → 跳过；
- `resolveModel` 未配置 → 跳过（保持 pending，配置后可重试）；
- **同步前缀**：`failedBooks.delete(bookId)` + `inFlightBooks.add(bookId)`（使 generate handler 即时派生出 `generating`）；
- 输入 = `readBookText(..., { maxChars: BOOK_SUMMARY_INPUT_MAX_CHARS }).text`，`BOOK_SUMMARY_SYSTEM`「概括整本书，覆盖核心主题/主要人物/结构脉络；忠实、数段、仅输出摘要」，`maxOutputTokens ≈ 1024`；
- 成功：`db.update(books).set({ summary: text })`（→ 派生 ready）；异常：`failedBooks.add(bookId)`（→ 派生 unavailable）+ 日志；
- `finally`：`inFlightBooks.delete(bookId)`。自含全部 reject（端口 `=> void`）。

### 2.4 IPC / DTO / preload

- 通道：`contentBookSummary: "content:book-summary"`（get，`bookIdInput` → `BookSummaryContentDto`）、`contentGenerateBookSummary: "content:generate-book-summary"`（触发，`bookIdInput` → `BookSummaryContentDto`）。
- `src/shared/library.ts`：`export interface BookSummaryContentDto { status: SummaryStatus; summary: string | null }`。
- `library-handlers.ts`：get handler 返回 `getBookSummaryView(getDb(), bookId)`；generate handler fire-and-forget `ensureBookSummary(makeSummaryDeps(), bookId)` + 同步返回 `getBookSummaryView`（同步前缀已置 generating）。
- `preload.ts`：`content.bookSummary(input)` / `content.generateBookSummary(input)`。

### 2.5 UI（侧栏书卡）

`Sidebar` 现为 目录/标注 Tabs；在其**上方**加一个轻量 **BookCard**：显示书名/作者 + 全书摘要状态徽标，点开 Popover（镜像 `SummaryPill`）看摘要正文 + 「生成摘要」按钮（`pending`/`unavailable` 时显示）；`pending`/`generating` 时轮询 `content.bookSummary`。书名/作者取 `window.api.library.get({bookId})`。复用 shadcn `Popover` + `Button` + 现有 BADGE 状态映射（可从 `SummaryPill` 提取共享 `SUMMARY_BADGE`）。

## 3. 测试（headless）

- `content.test.ts`：`readBookText` 按序拼接多章、到 `maxChars` 截断（`truncated:true`）。
- `summary.test.ts`：`getBookSummaryView` 未生成→`pending`、summary 非空→`ready`；`ensureBookSummary` pending→写入 summary（mock model，派生 ready）；已 ready 则跳过（不重生）；模型未配置保持 pending（不写）；异常→`failedBooks` 派生 `unavailable`；**重启语义**：清空内存 Set 后 summary 仍在→派生 ready、generating/failed 自然消失（无需 resetStuck）。
- 回归：现 192 测试不破 + 新增全绿；typecheck/lint 绿。

## 4. 非目标

- 导入时自动生成（按需触发；可后续加「导入后台预生成」开关）。
- 超长书的分块/map-reduce（用户选「直接喂」+ 高位截断；超大书前载截断已够 best-effort）。
- 跨章组合摘要（独立 backlog，ma4-deferred #8）。
