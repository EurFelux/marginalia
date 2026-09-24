# Marginalia · RA1-full（虚拟化连续 ePub 渲染 + CFI 锚定）设计文档

> 状态：设计已确认（react-virtuoso + 独立包 改版），待落实施计划
> 日期：2026-06-02
> 轨道：**渲染层轨（RA）· RA1-full**——把 RA1-min 的「静态纯文本渲染」升级为**全书连续滚动**的真实 ePub 渲染（HTML/CSS/图片）+ **CFI 锚定**，**内存有界**（虚拟化）。
> 上游：[`core-reading-loop-design`](2026-05-31-marginalia-core-reading-loop-design.md)、[`vertical-slice-design`](2026-06-01-marginalia-vertical-slice-design.md)、[`ROADMAP`](../ROADMAP.md)。

---

## 1. 目标与非目标

**目标**：渲染层以**全书连续滚动**呈现真实 ePub（排版/图片/结构），**内存有界**（虚拟化，只挂载视口附近 section）；当前位置与选区以 **CFI** 锚定，打通 **CFI 进度存取**；把 RA2 选区→AI 链路从「静态 DOM + 字符偏移」迁到「虚拟化 iframe + CFI」，**AI 契约零改动**。

**成功判据**：真实排版/图片**连续滚动**读整本，长书内存不随阅读无界增长（DOM 节点/内存有界）；ChapterList 跳章、当前章高亮；重开恢复位置；偏好实时生效；真实渲染上划选仍触发工具栏→chips→真模型流式回复。

**非目标（刻意推迟，见 §8）**：标注渲染/持久化（RA3+M-b，本轨已捕获存 `cfiRange`）· 分页/翻页模式 · 搜索 · 暗色主题 · chip/消息「跳回原文」· 跨章选区→独立会话（RA4）· 嵌套 TOC · 子 section 切块（超大单 spine 项的 intra-section 虚拟化，先按 section 粒度）。

---

## 2. 设计决策（拍板表）

| #   | 决策点       | 结论                                                                                                                                                                                                                                          |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阅读形态     | **全书连续滚动**（核心需求，不让步）                                                                                                                                                                                                          |
| 2   | 虚拟化       | **用现成库 [react-virtuoso](https://virtuoso.dev/)**（专精「未知变高 + 渲染后测量 + 不跳」）——**不自造** `computeWindow`/滚动锚定                                                                                                             |
| 3   | epub.js 角色 | **作解析 / 资源 / CFI 库**：`ePub(bytes)` → `book.spine`、`section.load(book.load.bind(book))`（**资源已解析**的文档）、`EpubCFI`。**不用** 其 Rendition/manager                                                                              |
| 4   | 模块边界     | **抽独立 package `@marginalia/virtual-docs`**（名可改）：**epub-agnostic** 的「虚拟化 iframe 文档列表」薄封装（virtuoso + iframe 自适应高度 + 选区事件）。epub.js/CFI 胶水留消费方（app/prototype）。便于在 **ui-prototype 用合成数据先实验** |
| 5   | 主进程角色   | **仍是 AI 内容权威**：`content.chapterText`/`readChapterText` 工具/章节摘要照旧从字节抽纯文本；渲染层只负责显示                                                                                                                               |
| 6   | 选区生产者   | 包发 `onSelect(index, range, doc, rect, text)`；消费方据此做块级取段（`buildChipsInput` 老形状）+ `section.cfiFromRange`→`SelectionInfo.cfiRange`。**下游 AI 链路一行不改**                                                                   |
| 7   | epub 依赖    | 优先 `epub.ts`（likecoin 的 epubjs v0.3.93 全类型重写）以获强类型；否则 `epubjs` + 最小 `d.ts`（plan 安装时核对确切包名）。同引擎，不影响虚拟化                                                                                               |

**关键洞察**：① 全书连续滚动的「变高虚拟化」是**已被解决的通用问题**——react-virtuoso 专为「未知高度、渲染后测量、滚动不跳」而生（官方点名 tweets/含图片聊天/markdown 场景）。**不重复造轮子**。② epub.js 真正难/稳的底层积木（OPF/spine 解析、`section.load` 的资源解析成 blob URL、`EpubCFI`）可复用；弱的只是其 manager——我们绕开。③ 自造部分收敛到**薄胶水**（iframe 自适应高度、epub→html、range→CFI、选区桥），风险大降。

---

## 3. 架构与数据流

### 3.1 取数与解析（app 侧 epub 胶水）

- 新增 `library.readEpubBytes(bookId) → Uint8Array`（主进程读 `books.path`；与 `send-deps.ts` 的 `createLoadBytes` 同一 `readFile` 模式）。渲染层开书时一次性取字节（`useQuery` + `staleTime: Infinity`）。
- `const book = ePub(bytes); await book.ready;` → 用 `book.spine`、`section.load(book.load.bind(book))`（资源已解析的 `Document`）、`section.unload()`、`EpubCFI`/`section.cfiFromElement|cfiFromRange`。

### 3.2 package `@marginalia/virtual-docs`（虚拟化 iframe 文档列表，epub-agnostic）

薄封装 react-virtuoso，**不知 epub/CFI**。对外 API（示意）：

```ts
interface VirtualDocsProps {
  count: number;
  loadSection: (index: number) => Promise<string>; // 该 section 的（资源已解析）HTML 串
  estimateHeight?: (index: number) => number; // 初值估高，减少初始抖动
  styleCss?: string; // 注入每个 iframe（承载阅读偏好）
  initialIndex?: number;
  onTopIndexChange?: (index: number) => void; // 视口顶部 section 变化（→当前章/进度）
  onSelect?: (e: {
    index: number;
    range: Range;
    doc: Document;
    rect: DOMRect;
    text: string;
  }) => void;
  onSelectionCleared?: () => void;
}
// + 命令式 ref：scrollToIndex(index)
```

内部：`<Virtuoso totalCount={count} itemContent={i => <SectionFrame .../>} initialTopMostItemIndex={initialIndex} rangeChanged={…} ref={…}/>`。每项 `SectionFrame` = 一个 iframe：`loadSection(i)` 的 HTML 注入 `srcdoc`（`sandbox="allow-same-origin"`、禁脚本）；**iframe 按内容自适应高度**（load + 内部 `ResizeObserver` 把 `iframe.style.height = contentDocument.documentElement.scrollHeight`）→ virtuoso 测外层 wrapper 即得真高、做窗口化与滚动锚定；注入 `styleCss`；挂 `mouseup`/`selectionchange` 发 `onSelect`/`onSelectionCleared`（rect 已加 iframe 视口偏移）。

> 虚拟化（窗口/测量/锚定）= **virtuoso 的活**；我们只负责「iframe 自适应高度 + 选区事件」。

### 3.3 位置 / 进度 / 当前章（app 侧）

- `onTopIndexChange(index)` → ① `book.spine.get(index).href` → 纯函数 `chapterIdByHref(chapters, href)` → 高亮 ChapterList + `setCurrentChapter` ② 防抖 `progress.save({bookId, cfi})`（cfi 由顶部 section + 段内位置经 `cfiFromElement` 算）。
- **恢复**：开书取 `progress.get` 的 CFI → `spine.get(cfi)` 得 index → `scrollToIndex(index)`。无存档从 0。
- **跳章**：ChapterList 点击 → `spine.get(href)` index → `scrollToIndex(index)`。

### 3.4 阅读偏好 → 注入 CSS（app 侧）

`fontScale`/`lineHeight`/`maxWidth`（`reader-store.prefs`）经纯函数 `prefsToCss(prefs)` 生成 CSS 串，作为 `styleCss` 传给包 → 注入每个 iframe（字号 %、行距、正文 `max-width`/`margin`）。偏好变更 → 新 `styleCss` → 包更新已挂载 iframe 样式 → iframe 高度变 → virtuoso 自动重测重锚。

### 3.5 数据流一句话

`主进程字节 → app 用 epub.js 解析 + virtual-docs 包虚拟化渲染（virtuoso 窗口化 iframe）+ CFI；AI 上下文/摘要仍走主进程纯文本`。

---

## 4. 选区桥接（RA2 迁移，app 侧消费包的 onSelect）

整条 AI 链路不变，**只换"选区生产者"**：删 RA1-min 的 `useSelection`（静态 DOM）+ ReaderPane 的 `data-paragraph` 标记；改为消费包的 `onSelect`。

1. **包发事件**：`onSelect({ index, range, doc, rect, text })`（rect 已是 viewport 坐标）。
2. **上下文提取**（app `epub-selection.ts`）：在 `doc`/`range` 上取块级前/当/后段。⚠️ 是**书的原生 HTML**、无 `data-paragraph`——`paragraphOf` = 「最近块级祖先（`p/div/li/blockquote/section…`）」，前/后段取相邻块级兄弟。产出仍是 `buildChipsInput` 老形状（`selection` + `paragraphBefore/Current/After` 纯字符串），**AI 契约零改动**。
3. **CFI 落点**：`book.spine.get(index).cfiFromRange(range)` → `SelectionInfo.cfiRange`（存供未来 RA3；AI chips 不需要 CFI，`buildChipsInput` 不动）。
4. **写 store**：组装 `SelectionInfo`（含 `rect`、`cfiRange`）→ `setSelection`。`SelectionToolbar`（fixed，消费 `store.selection.rect`）照旧。
5. **清除**：包 `onSelectionCleared` → `setSelection(null)`。

> 净效果：`SelectionToolbar`/`useAiActions`/`AIPanel`/`Composer`/`reader-store` 的 AI 部分**一行不改**。

---

## 5. 模块 / 接口 改动清单（供 plan 派生）

**新 package `packages/virtual-docs`（workspace 成员，源码消费，仿 `epub-parser`）**

- `package.json`：`@marginalia/virtual-docs`、`private`、`type:module`、`main/types/exports → ./src/index.ts`、deps `react-virtuoso`、peerDeps `react`/`react-dom`、scripts `test`/`typecheck`。
- `src/VirtualDocs.tsx`（虚拟化列表）+ `src/SectionFrame.tsx`（自适应高度 iframe + 选区事件）+ `src/index.ts`。
- 主应用经 `"@marginalia/virtual-docs": "workspace:*"` 消费；ui-prototype（隔离 lock）经 Vite **源码别名** import `packages/virtual-docs/src` 实验，并 `pnpm add --ignore-workspace react-virtuoso`（原型隔离装包坑，见记忆）。
- ⚠️ **ABI**：根 `pnpm add react-virtuoso`/装包后 better-sqlite3 会重编为 Node ABI → 跑 `pnpm db:rebuild:electron` 翻回。

**主进程**

- `src/shared/ipc.ts`：新增 `libraryReadEpubBytes: "library:read-epub-bytes"`。
- `src/main/ipc/library-handlers.ts`：新增 handler（`bookIdInput` → `readFile(getBook(db,bookId).path)` → `Uint8Array`；缺书抛可读错误）。

**preload**

- `src/preload.ts`：`library.readEpubBytes(input: BookIdInput): Promise<Uint8Array>`；补 `progress.get(input: BookIdInput)` / `progress.save(input: SaveProgressInput)`（既有 IPC，竖切未暴露）。

**渲染层 · 纯逻辑（headless 可测）**

- `src/renderer/reader/chapter-id-by-href.ts`：`(chapters, href) => id | null`。
- `src/renderer/reader/prefs-to-css.ts`：`(prefs) => cssString`。

**渲染层 · epub 胶水 / 接线（手测）**

- `src/renderer/reader/EpubReader.tsx`：取字节 → `ePub` 解析 → 渲染 `<VirtualDocs count loadSection estimateHeight styleCss onTopIndexChange onSelect/>` → 接 CFI/进度/跳章/当前章。
- `src/renderer/reader/epub-book.ts`：`ePub(bytes)` + `loadSection(i)`（`section.load`→序列化 HTML）+ `estimateHeight(i)`（按文本长度）+ CFI 辅助。
- `src/renderer/reader/epub-selection.ts`：消费包 `onSelect` → 块级取段 + `cfiFromRange` → `SelectionInfo`。

**渲染层 · 改/删**

- 改 `src/renderer/types.ts`：`SelectionInfo` 加 `cfiRange: string | null`。
- 改 `src/renderer/reader/ReaderView.tsx`：`ReaderPane` → `EpubReader`。
- 改 `src/renderer/query/keys.ts`：加 `qk.epubBytes(bookId)`；`qk.chapter` 随删除废弃。
- 删 `src/renderer/reader/ReaderPane.tsx` + `src/renderer/reader/useSelection.ts`。

---

## 6. 错误处理（不静默）

| 场景                     | 处理                                                   |
| ------------------------ | ------------------------------------------------------ |
| `readEpubBytes` 失败     | IPC 抛可读错误 → 显错误态 + 「返回书库」，不空白       |
| epub.js 解析失败（坏书） | catch → 显「无法渲染此书」+ 原因，不崩                 |
| 单 section `load` 失败   | 该项 iframe 显占位错误块（保留估高），不挡其余滚动     |
| 进度恢复 CFI 失效        | `spine.get(cfi)` 失败 → 从头显示，不挡阅读             |
| 选区上下文提取失败       | best-effort → 退化为只发选中文本，绝不静默吞掉 AI 提问 |
| ePub 内资源缺失          | epub.js 逐资源处理（缺图占位），阅读继续               |

---

## 7. 测试策略

虚拟化（窗口/测量/锚定）已是 **react-virtuoso 的职责**（成熟库，非我们的测试负担）；自造部分是薄 DOM 胶水。

- **可 headless 测的纯单元**：`chapterIdByHref`、`prefsToCss`（渲染层纯映射）· `readEpubBytes` handler（主进程 + `:memory:` + fixture：返字节 / 缺书抛错）。
- **package**：虚拟化交给库；包内 iframe/选区是 DOM 绑定 → 在 **ui-prototype 用合成变高 section（+图片）实验**为主（验：向上滚不跳、iframe 自适应、选区事件/坐标）；可纯函数化的小工具（如坐标平移）单测。
- **手测检查点**（`pnpm start`，DOM/iframe/CFI/选区强依赖浏览器、无 DOM 不可 headless——`vertical-slice` §9 已认可）：真书渲染（排版/图片）· 连续滚动顺滑 + **长书内存有界**（DevTools 看 DOM/内存不随滚无界涨）· 跳章 + 当前章高亮 · 重开恢复位置 · 偏好实时生效 · 真实渲染上端到端 AI · 各错误态。

---

## 8. 刻意推迟 / 已评估不采纳

**推迟**：子 section 切块（超大单 spine 项；本轨按 section 粒度，超大单章挂一个大 iframe——少见边界，先接受）· 标注渲染/持久化（RA3+M-b，`cfiRange` 已备）· 分页/翻页模式 · 搜索 · 暗色主题 · chip/消息「跳回原文」· 跨章选区→独立会话（M-c/RA4）· 嵌套 TOC · 章内字符级 ranges（标注用，留 RA3）。

**已评估不采纳**：

- **自造虚拟化（computeWindow + 滚动锚定）**——「变高 + 渲染后测量 + 不跳」是已解决的通用问题，react-virtuoso 专精此道；自造等于重复造轮子且赌正确性。改用库。
- **[foliate-js](https://github.com/johnfactotum/foliate-js)** 作基座——现代多格式 ePub 渲染引擎，但**官方明确不支持连续滚动**（仅 scrolled per-section + 分页），撞我们的核心需求，出局。
- **[pretext](https://github.com/chenglou/pretext)**——纯文本测量库，只测「已知字体/宽度/行距的受控文本」、不做完整 CSS/图片排布；而 ePub section 是须 iframe 忠实渲染的外来 HTML，无法预算其高度。仅当改走「弃 iframe、抽纯文本 + 受控样式自渲」（丢失真实排版/图片）才适用——非本轨目标。
- **@tanstack/react-virtual**——与我们 Query 同家、headless，但向上滚动的动态高度锚定历史上较抖（#659），未知变高场景 virtuoso 更专精。本轨选 virtuoso。

---

## 9. 落地后流程与分期（风险递增）

```
本 spec → writing-plans（bite-sized 计划） → subagent-driven 实现
```

1. **主进程 `readEpubBytes` + preload 接线**（含 progress）——headless 测 handler。
2. **package `@marginalia/virtual-docs`**：virtuoso + 自适应 iframe + 选区事件；**在 ui-prototype 用合成变高 section（+图片）实验**（向上滚不跳、iframe 自适应、选区坐标）。
3. **app `EpubReader` + epub-book 胶水**：`ePub` 解析 + `loadSection` 接包 → 替换 ReaderPane（手测：真书连续滚动、内存有界）。
4. **CFI 进度 + 恢复 + 跳章 + 当前章**（手测）。
5. **偏好注入 CSS**（手测）。
6. **选区桥 + RA2 迁移**（消费 `onSelect`→取段+CFI→`SelectionInfo`；手测：端到端 AI）。
7. **错误态收尾** + 删 ReaderPane/useSelection。
