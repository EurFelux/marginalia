# 书内全文搜索 · 设计文档

> 日期：2026-09-24
> 关联：issue #110（0.19 minor 主打）。

## 背景与目标

阅读器没有书内搜索。想找「那句话在哪」只能手动翻，或者去问 AI。这是阅读器的基本能力缺口，也是新用户最先会按的 ⌘F。

**目标**：在当前书内（ePub 与有文本层的 PDF）按关键词查找，列出所有命中及上下文，点击即跳到原文并高亮。

**成功判据**：

1. ⌘F / Ctrl+F 在阅读器任意焦点（含 ePub 正文 iframe 内）打开搜索并聚焦输入框；侧栏收起时自动展开。
2. 结果按章节分组，每条带前后文片段，命中词加粗；显示总数，超出上限时说明只显示前 N 条。
3. 点击结果、或在输入框按 Enter / ⇧Enter，跳到对应命中：ePub 定位到命中所在元素，PDF 定位到命中矩形；当前命中醒目高亮，已渲染区域内的其他命中淡色高亮。
4. 中英文都能搜：大小写不敏感，全角/半角等价，跨行、跨标签的空白差异不影响匹配，中文不依赖词边界。
5. 扫描版 PDF 给出明确说明，不静默返回空结果。

**验证方式**：匹配、文本流构建、主进程搜索、状态机事件走 vitest；ePub/PDF 跳转与高亮走实机验证（隔离 userData + CDP 驱动）。

## 范围

**在范围内**：当前书的全文搜索；侧栏「搜索」标签页；⌘F 快捷键；结果跳转与正文高亮。

**不在范围内**：

- 跨书 / 整个书库搜索（以后可在书库或交给书库 AI 助手）。
- 正则、全词匹配、区分大小写等高级选项。
- 变音符折叠（café ≠ cafe）、繁简转换、同义词。
- 搜索历史。
- 扫描版 PDF 的 OCR。

## 关键决策

### 1. 搜索在主进程做，定位在渲染层做

- **主进程**负责「在哪些地方命中」：解压书文件、构建每个 spine 文件 / 每页的文本流、匹配、按章节归属、生成片段。符合「主进程厚」规则，可无头测试。
- **渲染层**只负责把命中锚回真实 DOM：跳转与高亮需要 DOM 几何，这天然属于渲染层。

### 2. 可搜索文本必须忠实于显示内容——不复用 AI 的 `htmlToText`

`htmlToText` 只收集 `p` / `h1`–`h6` / `li` 等块级元素，表格、`<div>` 段落里的正文会被漏掉（有些 ePub 正文就是 div）。搜索要「看得见就搜得到」，所以用新的**文本流**：`<body>` 下所有文本节点按文档序拼接，排除 `script` / `style` / `template` / `noscript` 子树。

块级元素（含 `br`、`td`、`div` 等）的边界记为**虚拟断点**：不进入文本流本身（保证文本流偏移 = DOM 文本节点偏移），只在匹配时视作一个空白，避免相邻段落首尾粘连误匹配。

文本流构建是一个**共享纯函数**（`src/shared/text-flow.ts`），通过适配器同时作用于主进程的 node-html-parser 树与渲染层的真实 DOM——两侧规则一字不差，命中序号才能对齐。

### 3. 匹配规则（`src/shared/text-search.ts`，纯函数）

对文本流逐码点规整，同时记录「规整后下标 → 原文下标」映射：

1. NFKC（全角字母数字 → 半角，兼容字符展开，如 ﬁ → fi）；
2. 小写化；
3. 所有空白（含 NBSP、全角空格、虚拟断点）折叠为单个空格；
4. 两个 CJK 字符之间的空白删除（PDF 与源码换行常把中文句子断开）。

查询串做同样规整并去掉首尾空白。匹配为规整后字符串上的顺序非重叠 `indexOf`，结果映射回文本流的 `[start, end)`。

### 4. 命中定位

| 格式 | 主进程返回的 target                                         | 渲染层如何锚定                                                                                                    |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ePub | `{ href, occurrence }`：spine 文件路径 + 该文件内第几个命中 | 在该 section 的 iframe 文档上用同一套文本流与匹配重算，取第 `occurrence` 个；数量对不上时取最后一个（不静默失败） |
| PDF  | `{ page, start, end }`：文本层文本流偏移                    | 与 PDF 标注同一坐标空间（`getTextContent` items 顺序、不含 EOL），直接 `rangeFromOffsets`                         |

ePub 不返回字符偏移：主进程与浏览器对同一 XHTML 的解析细节（空白节点、容错嵌套）可能有细微差别，偏移会错位；「第 k 个命中」只依赖文字内容，对这类差异稳健。

PDF 主进程用与渲染层 `streamTextContent()` 相同的默认参数调用 `getTextContent()`，文本流一致；EOL 记为虚拟断点。

### 5. 章节归属

- **ePub**：一个 spine 文件内可能有多个锚点章。构建文本流时记录每个元素 id 的起始偏移；命中归属为「同文件内锚点偏移 ≤ 命中位置的最后一章（无锚点章视为偏移 0）」；文件内没有章节（孤儿 spine 文件）则归前一个文件的最后一章——与 `extractChapterAcrossSpine` 的归章语义一致。
- **PDF**：`startPage ≤ page` 的最后一章；无目录时为 null（UI 显示页码分组）。

### 6. 上限与性能

- 命中上限 500，超出返回 `truncated: true`。
- 主进程按 bookId 缓存构建好的文本流（LRU 2 本）。book id 是内容哈希，同一 id 的字节不变，缓存无需失效。
- 渲染层输入防抖 250ms；React Query 以 `(bookId, query)` 为 key 缓存结果。

## 设计

### IPC

`content:search`：入参 `{ bookId, query }`（query 1–200 字符），出参：

```ts
type BookSearchResult =
  | { kind: "ok"; hits: BookSearchHit[]; truncated: boolean }
  | { kind: "no-text-layer" };

interface BookSearchHit {
  chapterId: string | null;
  chapterTitle: string | null;
  snippet: { before: string; match: string; after: string };
  target:
    | { format: "epub"; href: string; occurrence: number }
    | { format: "pdf"; page: number; start: number; end: number };
}
```

### 渲染层

- **`search-store`**（zustand）：当前书的 `query`、`hits`、`activeIndex`、侧栏受控标签页 `sidebarTab`、`focusRequest`（自增以聚焦输入框）、`jump`（`{ hit, seq }`，阅读器据 seq 消费）。换书重置。
- **侧栏**：`Tabs` 改为受控（值来自 store），新增「搜索」标签页（第二位，紧随目录）。
- **`SearchPanel`**：输入框 + 「当前 / 总数」+ 上下按钮；Enter 下一个、⇧Enter 上一个；结果按章节（PDF 无章节时按页）分组，片段中命中部分加粗。空态：未输入提示、无结果、扫描版 PDF 说明、截断说明、错误信息。
- **快捷键**：`ReaderView` 在 document 捕获阶段监听 ⌘F / Ctrl+F；ePub 正文在 iframe 内，`VirtualDocs` 新增 `onKeyDown` 回调由 `SectionFrame` 转发 iframe 的 keydown。
- **ePub 跳转**：阅读位置状态机新增 `SEARCH_HIT_REQUESTED` 事件（loading 期间忽略；其余进入 following 并发 `notifyTtsUserNavigation` + `scrollToSearchHit`），执行器用 `scrollToSectionElement(index, doc => 命中起点所在元素)`，与标注跳转同一原语。
- **ePub 高亮**：CSS Custom Highlight API（`::highlight(marginalia-search)` / `::highlight(marginalia-search-active)`），不改 DOM，不影响 CFI 与标注 `<mark>`。section 渲染时经 `decorate` 应用，hits / activeIndex 变化时对已挂载 section 重算。
- **PDF 跳转与高亮**：`PdfPage` 接收本页命中，按标注同款方式（`rangeFromOffsets` + `relativeRects`）画一层独立覆盖；跳转时先 `scrollToIndex(page)`，页面文本层就绪后把当前命中矩形 `scrollIntoView({ block: "center" })`。

## 测试

- `text-search`：NFKC / 大小写 / 空白折叠 / CJK 间空白 / 虚拟断点 / 偏移映射 / 非重叠 / 片段。
- `text-flow`：node-html-parser 适配器（主进程侧）与 happy-dom 适配器（渲染层侧）对同一 HTML 产出相同文本流、断点与锚点偏移；排除 script/style。
- 主进程 `searchBook`：fixture ePub（命中数、href、序号、章节归属）、fixture PDF（页码与偏移可在文本流中取回命中词）、扫描版 PDF → `no-text-layer`、上限截断。
- 状态机：`SEARCH_HIT_REQUESTED` 在 loading 忽略、其余发出跳转 effect。
- ePub 锚定：happy-dom 中按序号取回 Range，序号越界取最后一个。
