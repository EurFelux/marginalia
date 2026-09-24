# reader 上下文合并 library 工具设计

- **Issue**: [#98](https://github.com/EurFelux/marginalia/issues/98) — Expose library tools in the reader-view AI panel
- **日期**: 2026-06-16
- **状态**: 设计已认可，待写实现计划
- **关联**: [#90 书库 AI 伴侣](2026-06-16-library-ai-companion-design.md) 的反向延伸——#90 把 AI 带进**书库**（library 上下文），本设计把 library 工具带进**阅读器**（reader 上下文）。

## 1. 背景与目标

#90 建立了 `ChatContext` 脊柱：主进程侧以 `bookId` 的空/非空区分上下文，两套工具**互斥**——

- `bookId` 非空（reader）→ reading 工具（`getToc` / `readChapterText` / `getChapterSummary` / `readPage`）
- `bookId` 为 null（library）→ library 工具（`listBooks` / `getBook` / `getBookNotes` / `listAnnotations` / `getReadingStats`）

**现状缺口**：reader 里的 AI 完全够不到书库。读者在书内想问「这本和我读过的 X 比怎样」「我在 Y 里标注了啥」「这周读了多少」，必须先退出当前书、切到书库 AI 入口。这道隔离墙是 #90 实现方式（互斥 if-else）的副产物，并非有意的产品约束。

**目标**：让 reader 上下文的 AI 也能调用 library 的只读工具。这是**单向 reader→library 扩展**。

**范围裁定（已与用户确认）**：

- 只暴露现成的**书级** library 工具；**不做跨书读正文**（reading 工具仍闭包绑定当前书）。
- **library 全局上下文不变**——它本就有全部 library 工具；给它 reading 工具需要「跨书读正文」，已排除。
- 新增一个 reader 便捷工具 `getBookSummary`（当前书全书摘要，免 id），见 §3.1。

## 2. 行为契约

| 维度                | 改动前（reader）                                           | 改动后（reader）                                                          | library 上下文    |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| reading 工具        | ✅ getToc / readChapterText / getChapterSummary / readPage | ✅ 不变                                                                   | —                 |
| library 工具        | ❌ 够不到                                                  | ✅ listBooks / getBook / getBookNotes / listAnnotations / getReadingStats | ✅ 不变           |
| 当前书全书摘要      | ❌（仅有章节摘要 getChapterSummary）                       | ✅ 新增 getBookSummary（无参）                                            | 经 getBook(id) 取 |
| memory / web_search | ✅ 现有门控                                                | ✅ 不变                                                                   | ✅ 不变           |

reader 的 AI 由「只懂当前这本书的伴侣」升级为「主聚焦当前书、同时能纵览整个书库」的伴侣。

## 3. 改动点（3 个文件）

### 3.1 reading 工具新增 `getBookSummary`（`src/main/ai/tools.ts`）

在 `createReadingTools` 的 `base` 中新增，与 `getChapterSummary` 对称——无参、闭包绑定当前 `bookId`、复用现成的 `getBookSummaryView`：

```ts
getBookSummary: tool({
  description:
    "Get the AI-generated whole-book summary (and its status) for the book you're reading.",
  inputSchema: z.object({}),
  execute: async () => runTool("getBookSummary", () => getBookSummaryView(db, bookId)),
}),
```

新增 `import { getBookSummaryView } from "@main/ai/summary";`（文件已 import 同模块的 `getChapterSummaryView`）。

**与 library `getBook` 的关系**：`getBook(bookId)` 返回里也带 `summaryStatus` + `summary`（`library-tools.ts:50-62`），但它**需要 id 参数**，而当前书的 library `id` 对 agent 不可见（reading 工具闭包绑定、prompt 不注入 id）。只靠 `getBook` 取当前书摘要，agent 须 `listBooks` → 靠标题猜当前书 → `getBook(id)`，标题匹配在同名/不确定「哪本算当前」时脆弱。两者**非完全正交**，但各管一头、可接受：

- `getBookSummary()` → **当前书**全书摘要（免 id，高频，reader 用）
- `getBook(id)` → **任意指定书**的元数据 + 摘要（需 id，跨书用，library 用）

### 3.2 工具组装：reader 合并两套工具（`src/main/ai/stream-assistant.ts`）

现状（`stream-assistant.ts:75-77`）是互斥 if-else：

```ts
const contextTools = bookId
  ? createReadingTools({ db, bookId, loadBytes, imageToolResults })
  : createLibraryTools({ db });
```

改为：`bookId` 非空 → reading + library 合并；`bookId` 为 null → 仅 library。

```ts
const contextTools = bookId
  ? {
      ...createReadingTools({ db, bookId, loadBytes, imageToolResults }),
      ...createLibraryTools({ db }),
    }
  : createLibraryTools({ db });
```

键名无冲突（reading 与 library 工具名不重叠）。memory / search 工具的合并与门控**不变**。

把这段「按 bookId 决定 contextTools」的逻辑抽成一个**可测纯函数**（如 `createContextTools(deps)`，位置由实现计划定），便于单测「reader 含两套键 / library 只含一套」——此前该组装逻辑内联在 `stream-assistant.ts`，无 `stream-assistant.test.ts` 覆盖。

**prompt-cache 稳定性**：工具集按上下文**恒定**（reader 永远 = reading + library + memory + search），不是 per-turn toggle，tools→system→messages 前缀缓存不受影响（遵守 `prompt-caching` 设计的工具门控纪律）。

### 3.3 system prompt（`src/main/ai/base-prompt.ts`）

现状 reader 用 `BASE_SYSTEM_PROMPT`（"reading companion"），完全不提 library 工具；library 用 `LIBRARY_SYSTEM_PROMPT`（"personal librarian"，明确列举 library 工具用法）。

改法：把 `LIBRARY_SYSTEM_PROMPT` 中**描述 library 工具的片段抽成可复用常量**（避免两处维护），reader 模板在「reading companion」主体后追加该片段 + 一句定调：

> 主聚焦当前所读之书（reading 工具 + getBookSummary）；当读者问到其他书、整个书库、推荐、阅读统计或跨书对比时，使用 library 工具，且始终以工具结果与记忆为准、不臆造未拥有的书。

`LIBRARY_SYSTEM_PROMPT` 继续供 library 上下文使用（可由同一抽取片段重组，保持单一真相源）。

### 3.4 `src/main/ai/send.ts`：不动

放弃「注入当前书 id/title 到 prompt」方案——`getBookSummary` 已覆盖当前书摘要这一高频诉求，send.ts 无需改动。

## 4. 非目标（YAGNI）

- **不做跨书读正文**：reading 工具仍只读当前书；读者要别的书的正文，仍需打开那本书。
- **不改 library 全局上下文**：保持现有工具集与 prompt。
- **不引入 capability flag 之类抽象**：组装仍由 `bookId` 空/非空直接驱动。

## 5. 测试

- `tools.test.ts`：`getBookSummary` 返回当前书的全书摘要 view（status + text），并走 `runTool` 的错误转 `{ error }` 纪律。
- 工具组装纯函数测：`bookId` 非空 → 同时含 reading 与 library 工具键；`bookId` 为 null → 只含 library 工具键。
- `base-prompt.test.ts`：`kind="book"` 的 prompt 含 library 能力片段；`kind="library"` 行为不回归。
- `library-tools.test.ts` 已覆盖各 library 工具自身行为，不动。

## 6. 风险与权衡

- **当前书在两套工具下的双重可达**：当前书既可经 reading 工具读，也会出现在 `listBooks` 里、可经 `getBook(id)` 查。语义无冲突，prompt 的定调句负责引导 agent 优先用 reading 工具读当前书、用 library 工具处理跨书。
- **prompt 变长**：reader 模板追加 library 片段会增加固定 token；属上下文恒定开销，被 prompt caching 摊薄，可接受。
