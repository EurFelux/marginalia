# AI 书内搜索工具 · 设计文档

> 日期：2026-09-30
> 关联：issue #111；依赖 spec 2026-09-24-in-book-search-design（UI 搜索，本文不改它）。

## 背景与目标

书内搜索 UI 已把搜索核心落进主进程（`src/main/library/search.ts`），但 AI 助手定位内容仍只有 getToc → readChapterText/readPage 的「盲翻」路径——模型无法回答「这本书哪里谈到 X」这类问题，只能逐章读。

**目标**：reader 上下文新增 `searchBook` 工具，让模型按关键词搜当前书，命中带「可直接继续阅读」的精确定位。

**成功判据**：

1. 模型给出关键词，工具返回至多 20 条命中，每条含 chapterId、章节标题、命中前后各约 50 字符的上下文片段；超出上限带 `truncated` 标志，引导模型换更精确的词重搜。
2. ePub 命中带 `chapterOffset`，且该偏移与 `readChapterText` 的分页坐标**逐字节对齐**——模型直接 `readChapterText({ chapterId, offset })` 即可读到命中处，无需估计、无需窗口补偿（有测试直接断言此对齐）。
3. PDF 命中额外带精确 `page`（配 readPage）；扫描版 PDF 返回明确错误，不静默空结果。
4. UI 搜索路径（`src/main/library/search.ts` 及渲染层）零改动。
5. 索引构建不阻塞主进程：逐章让出事件循环，构建期间流式 AI 回复等其他 IPC 不受影响。

**验证方式**：parser 重构走既有测试全绿；语料构建、对齐、工具行为走 vitest（fixture 书）；端到端走实机冒烟（问助手一个书中冷僻词，验证它能定位并引用原文）。

## 范围

**在范围内**：

- reader 上下文（当前书）的 `searchBook` 工具。
- 一套新的 AI 专用搜索语料：以章为单位，文本与 readChapterText 坐标空间对齐。
- 配套缓存（LRU）与 parser 包的行为不变重构。

**不在范围内**：

- library 上下文 / 跨书搜索（语料按章构建，跨书会反复重建缓存；等真有需求再说）。
- 正则、全词匹配、区分大小写等高级选项。
- 把 UI 搜索迁到新语料（两套语料服务两种消费者，见决策 1）。
- 持久化索引（进程内 LRU 即可，AI 搜索频率远低于 UI 搜索）。
- 任何渲染层改动（工具结果由 SDK 既有的 tool part 渲染管道展示）。

## 关键决策

### 1. 独立语料，坐标空间与 readChapterText 逐字节对齐（用户决策 2026-09-30）

**问题**：最初设想复用 UI 搜索的索引给 AI 用。但 UI 搜索的文本流（`buildTextFlow`：`<body>` 下全部文本节点 + 虚拟断点）与 `readChapterText` 的提取路径（ePub 走 `htmlToText`：块级元素、空白折叠、`\n` 拼接；PDF 走 `extractPdfText`：逐页 `pageText` + `[p.N]` 标记）是**两套坐标空间**——pretty-print XHTML 的缩进换行、空白折叠差异、块间分隔不同，都会让偏移随章节长度累积漂移。UI 搜索自己对 ePub 都不敢用偏移（用 `href+occurrence` 让渲染层重算锚定），把估计偏移给模型只会让「读对应位置」变成不可靠的暗示。

**决策**：AI 工具不复用 UI 语料，另建一套**章节全文语料**——每章的文本就是 `readChapterText` 分页之前的那根完整字符串。命中偏移天然落在 readChapterText 的 offset 空间里，**精确而非估计**。这是本设计与 UI 搜索的本质区别：

|          | UI 搜索                                           | AI 搜索（本文）                                       |
| -------- | ------------------------------------------------- | ----------------------------------------------------- |
| 语料单位 | spine 文件 / 页                                   | 章（readChapterText 同款边界）                        |
| 文本构造 | `buildTextFlow`（全文本节点，「看得见就搜得到」） | `htmlToText` / `extractPdfText`（与模型可读内容一致） |
| 定位     | ePub `href+occurrence`（渲染层重算锚定）          | `chapterOffset`（精确，直喂 readChapterText）         |
| 覆盖     | 全部 spine 文件（含封面等无目录文件）             | 恰等于模型经 readChapterText 可达的内容               |

最后一行是个值得要性质：**搜索覆盖 = 模型可读覆盖**，不会出现「搜到了但读不到」的悬空命中。

**对齐不靠约定靠共享实现**：见决策 2——两条消费路径调用同一个字符串构造函数，恒等由构造保证，再加测试直接断言。

### 2. parser 包行为不变重构（对齐的实现前提）

- **epub-parser**：`extractChapterAcrossSpine` 拆出一个纯字符串核心 `chapterTextAcrossSpine(fileText, spine, start, end): string`（现在的区间/拼接/防御逻辑原样搬入，不分页）；原函数变薄壳 = `paginate(chapterTextAcrossSpine(...), opts)`。语料构建器复用同一核心，但 `fileText` 用 `unzipEntry` 按 spine 文件**惰性**取（带构建内 memo）——绝不用 `unzipSync` 全量解压（含图片的大书会爆内存/卡死，这正是 readBookText 注释里记录过的坑）。
- **章节边界**：readChapterText 里「下一目录项即本章终点」的查询逻辑（`src/main/library/content.ts`）抽成共享 helper，readChapterText 与语料构建器共用，边界语义单一来源。
- **pdf-parser**：同理抽 `chapterPdfText(doc, startPage, endPage): string`（逐页 `pageText` + `[p.N]` 标记 + `\n\n` 拼接的核心）；`extractPdfText` 变薄壳 = openPdf + 核心 + 分页。语料构建器 openPdf 一次、逐章构造，同时记录每个 `[p.N]` 标记在章文本中的偏移，命中按「最后一个 ≤ match.start 的标记」归页。

### 3. 匹配与片段完全复用 `src/shared/text-search.ts`

`buildSearchIndex` / `findInIndex` / `snippetAround` 与查询规整规则（NFKC、小写、空白折叠、CJK 间空白删除）原样复用——AI 搜索的匹配行为与 UI 搜索一致，用户对「什么词能搜到」的心智模型只需一套。章节文本没有虚拟断点，`breaks` 为空。

snippet 半径取 **before 50 / after 50**（用户定的启发式常量；比 UI 的 30/60 大，因为模型没有「点进去看」的第一跳，snippet 就是它判断相关性的全部依据）。

### 4. 语料缓存（进程内 LRU，独立于 UI 缓存）

新模块（`src/main/ai/search-corpus.ts`，名字实现时可再定）：

- `Map<"${bookId}:${parserVersion}", Promise<ChapterCorpus[]>>`，LRU 至多 2 本；失败不缓存、下次重试；逐章 `setImmediate` 让出事件循环（与 UI 搜索同一套理由与做法）。
- 与 UI 索引缓存相互独立：同本书可能同时占两份（章节文本 + 规整索引 ≈ 书文本大小的数倍），可接受——两套坐标空间无法互推，不强行合并。
- **不预热**：AI 搜索由模型自主触发，没有「用户打开搜索页」那样的预热时机；首次调用在大书上数百毫秒（工具调用本身异步，不阻塞流），后续瞬时。

### 5. 工具定义（`src/main/ai/tools.ts` createReadingTools）

- 名字 `searchBook`，reader 上下文恒注册、无门控（不像 web_search 有开关，因此不触碰 prompt-cache 稳定性问题）。
- input：`{ query: string, 1..200 }`。**不开放** maxHits / radius 参数（用户决策：固定 20 条、固定 ±50，少给模型乱填的维度）。
- output：
  ```ts
  {
    hits: Array<{
      chapterId: string;
      chapterTitle: string | null;
      snippet: { before: string; match: string; after: string };
      chapterOffset: number; // 精确，可直接喂 readChapterText 的 offset
      page?: number; // 仅 PDF：精确页码，可喂 readPage
    }>;
    truncated: boolean;
  }
  ```
- description 需向模型说清三件事：① 这是当前书的全文关键词搜索；② `chapterOffset` 是 readChapterText offset 空间里的精确命中起点，想读上下文就用 `offset = chapterOffset - N` 带窗口读；③ `truncated` 时换更具体的关键词。具体文案实现时与用户敲定（面向模型的 copy 直接影响调用质量）。
- 扫描版 PDF（无文本层）：execute 抛错经 `runTool` 转 `{ error }`，文案指明原因并（provider 支持图像时）提示改用 readPage image 模式——与 readChapterText 的「绝不静默空文本」防御一致。
- 无章节的书（chapters 表为空）：返回 `{ error }` 说明无法用章节定位搜索（这种书 readChapterText 本也不可达，覆盖一致性不破）。

### 6. Prompt 层面零改动

`BASE_SYSTEM_PROMPT` 已有 "use the available reading tools"；工具 description 自解释，不加软提示、不动现有 prompt 结构（保 prompt cache 前缀稳定）。

## 测试策略

1. **重构零行为变化**：epub-parser / pdf-parser / content.ts 既有测试全绿（extractChapterAcrossSpine、extractPdfText、readChapterText 行为不变）。
2. **语料恒等**：fixture 书上，语料构建器产出的每章文本 === readChapterText 全量翻页拼出的字符串（逐章断言）。
3. **对齐金测试**（ePub + PDF 各一）：搜索命中 → `readChapterText({ chapterId, offset: chapterOffset - k, maxChars: 2k + query.length })` 的切片在该位置包含查询词原文。
4. **工具行为**：20 条截断与 truncated 标志；扫描版报错文案；`runTool` 软失败形状；无章节书的报错。
5. **缓存**：同书二次调用不重建（spy 断言）；构建失败不缓存。

## 实施步骤（合并次序）

1. parser 包薄壳化重构 + content.ts 边界 helper 抽取（纯重构，先行合入）。
2. 语料模块 + 缓存 + 测试。
3. `searchBook` 工具接线（含 description 文案与用户敲定）+ 测试 + 实机冒烟。
4. 合并前 changeset（用户可见新能力，minor）。
