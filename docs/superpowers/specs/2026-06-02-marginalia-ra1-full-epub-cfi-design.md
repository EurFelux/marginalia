# Marginalia · RA1-full（虚拟化连续 ePub 渲染 + CFI 锚定）设计文档

> 状态：设计已确认（含虚拟化架构改版），待落实施计划
> 日期：2026-06-02
> 轨道：**渲染层轨（RA）· RA1-full**——把 RA1-min 的「静态纯文本渲染」升级为**全书连续滚动**的真实 ePub 渲染（HTML/CSS/图片）+ **CFI 锚定**，且**内存有界**（自造虚拟化）。
> 上游：[`core-reading-loop-design`](2026-05-31-marginalia-core-reading-loop-design.md)、[`vertical-slice-design`](2026-06-01-marginalia-vertical-slice-design.md)、[`ROADMAP`](../ROADMAP.md)。

---

## 1. 目标与非目标

**目标**：渲染层以**全书连续滚动**呈现真实 ePub（排版/图片/结构），**内存有界**（虚拟化，只挂载视口附近的 section）；当前位置与选区以 **CFI** 锚定，打通 **CFI 进度存取**；把 RA2 的选区→AI 链路从「静态 DOM + 字符偏移」迁到「虚拟化 iframe + CFI」，**AI 契约零改动**。

**成功判据**：真实排版/图片**连续滚动**读整本，长书内存不随阅读无界增长；ChapterList 跳章、当前章高亮；重开恢复位置；偏好实时生效；真实渲染上划选仍触发工具栏→chips→真模型流式回复。

**为何自造虚拟化**（核心约束）：**全书连续滚动是核心需求**。但 epub.js 的 `continuous` manager **不做有界内存**——官方示例自承「renders the entire ebook at once … consume more memory as the whole ebook is loaded」，且有闪烁/白屏等已知 bug。故**不用 epub.js 的 Rendition/manager**，改为复用其底层积木自造虚拟化渲染器（见 §2 决策 #3）。

**非目标（刻意推迟，见 §8）**：标注渲染/持久化（RA3+M-b，本轨已捕获存 `cfiRange`）· 分页/翻页模式 · 搜索 · 暗色主题 · chip/消息「跳回原文」· 跨章选区→独立会话（RA4）· 嵌套 TOC · **子 section 切块**（超大单 spine 项的 intra-section 虚拟化，先按 section 粒度，见 §8）。

---

## 2. 设计决策（拍板表）

| #   | 决策点       | 结论                                                                                                                                                                                                         |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | epub.js 角色 | **作解析 / 资源 / CFI 库**：`ePub(bytes)` → `book.spine`、`section.load(book.load.bind(book))`（返回**资源已解析**的文档）、`EpubCFI`。**不用** `book.renderTo`/Rendition/managers                           |
| 2   | 阅读形态     | **全书连续滚动**（核心需求，不让步）                                                                                                                                                                         |
| 3   | 虚拟化       | **自造**（方案 ①）：epub.js 作库 + **自造 React 虚拟化渲染器**——窗口化 section-iframe 列表 + 高度测量 + 滚动锚定，**内存有界**。粒度 = **section（章级）**                                                   |
| 4   | 主进程角色   | **仍是 AI 内容权威**：`content.chapterText`/`readChapterText` 工具/章节摘要照旧从字节抽纯文本；渲染层只负责显示                                                                                              |
| 5   | 选区生产者   | 选区从虚拟化 iframe 提取（逐 iframe 监听）；**下游 AI 链路一行不改**，只换生产者；CFI 经 `section.cfiFromRange` 捕获存 `SelectionInfo.cfiRange`                                                              |
| 6   | 依赖         | 优先 **`epub.ts`**（likecoin 的 epubjs v0.3.93 全类型重写，drop-in、970+ 测试）以获强类型；否则 `epubjs` + 最小 `d.ts`（plan 安装时核对确切包名/类型质量）。同引擎，**不影响虚拟化**（我们本就不用其渲染层） |

**关键洞察**：epub.js 真正难、真正稳的底层积木（OPF/spine 解析、`section.load` 的**资源解析成 blob URL**、`EpubCFI` 引擎）正是可复用的；弱的只是高层 manager。自造虚拟化 = **保留积木、替换 manager**。而虚拟化里最险的「窗口/锚定计算」是**纯逻辑**，可抽出 headless 测（见 §7）——风险集中在可测的纯函数里，是好事。

---

## 3. 架构与数据流

### 3.1 取数与解析

- 新增 `library.readEpubBytes(bookId) → Uint8Array`（主进程读 `books.path`；与 `send-deps.ts` 的 `createLoadBytes` 同一 `readFile` 模式）。渲染层开书时一次性取字节。
- `const book = ePub(bytes); await book.ready;` → epub.js 解析 OPF/spine/资源。我们只用 `book.spine`（有序 section）、`section.load(book.load.bind(book))`（**资源已解析**的 `Document`）、`section.unload()`、`EpubCFI`/`section.cfiFromElement|cfiFromRange`。

### 3.2 自造虚拟化渲染器（`VirtualizedReader`）

```
┌ 滚动容器（overflow-y:auto，内层高度 = Σ section 高度）
│  ├ [spacer/绝对定位] section[i-1]  ← 视口上方 overscan，已挂载
│  ├ [iframe] section[i]            ← 视口内，已挂载（srcdoc=解析文档 + 偏好样式）
│  ├ [iframe] section[i+1]          ← 视口下方 overscan，已挂载
│  └ …其余 section 不挂载，仅占位高度…
```

- **高度模型**：`heights: Map<index,number>`（实测）+ `estimate(index)`（未测：默认 px 或按 section 文本长度）；`offsetOf(index)` = 前缀和；`totalHeight` = Σ。
- **窗口**：纯函数 `computeWindow(scrollTop, viewportH, heights, count, estimate, overscan) → { mountedIndices, offsets, totalHeight }`——只挂载与 `[scrollTop−overscan, scrollTop+viewportH+overscan]` 相交的 section。
- **section 渲染**（`SectionFrame`）：首挂载时 `section.load(...)` → `XMLSerializer` 序列化解析文档 → iframe `srcdoc`；`sandbox="allow-same-origin"`（**禁脚本**，ePub JS 默认关，安全；allow-same-origin 供测量/选区/blob 资源）；注入偏好 `<style>`。
- **测量 + 滚动锚定**：iframe `load` 后读 `contentDocument.documentElement.scrollHeight` → 更新 `heights[index]` → 重算 offsets；**锚定**：若被测 section 在当前视口锚点**之上**，把容器 `scrollTop += (实测 − 估高)`，保可见内容不跳。（变高度虚拟化最难缠处，集中在 `computeWindow` + 锚定增量的纯逻辑里。）

### 3.3 位置 / 进度 / 当前章

- **滚动时**（rAF + 防抖）：取视口顶部所在 section + 段内位置 → CFI（视口顶 `caretRangeFromPoint`/首个可见块 `section.cfiFromElement`）。防抖 `progress.save({bookId, cfi})`。顶部 section 的 `href` → 纯函数 `chapterIdByHref(chapters, href)` → 高亮 ChapterList + `setCurrentChapter`。
- **恢复**：存档 CFI → `spine.get(cfi)` 得 index + 段内位置 → 滚到 `offsetOf(index)`（未测则滚到估高、测后校正）。无存档从头。
- **跳章**：ChapterList 点击 → `spine.get(href)` index → 滚到 `offsetOf(index)`。

### 3.4 阅读偏好 → 注入 CSS

`fontScale`/`lineHeight`/`maxWidth`（`reader-store.prefs`）经纯函数 `prefsToCss(prefs)` 生成 CSS 串，注入每个 section iframe 的 `<style>`（字号 %、行距、正文 `max-width`/`margin`）。偏好变更 → 更新所有已挂载 iframe 的注入样式 → 重测高度 → 重锚定。

### 3.5 数据流一句话

`主进程字节 → 渲染层 epub.js 解析 + 自造虚拟化渲染（窗口化 iframe）+ CFI；AI 上下文/摘要仍走主进程纯文本`。

---

## 4. 选区桥接（RA2 迁移）

选区发生在某个已挂载 section 的 iframe 内。整条 AI 链路不变，**只换"选区生产者"**：删 RA1-min 的 `useSelection`（静态 DOM）+ ReaderPane 的 `data-paragraph` 标记；新增逐 iframe 选区桥。

1. **捕获**：`SectionFrame` 给自身 iframe 的 `contentDocument` 挂 `mouseup`/`selectionchange`；非折叠选区 → 取 `window.getSelection().getRangeAt(0)`。
2. **上下文提取**：复用取段逻辑但作用在 iframe 文档上。⚠️ 是**书的原生 HTML**、无 `data-paragraph`——`paragraphOf` 改为「最近块级祖先（`p/div/li/blockquote/section…`）」，前/后段取相邻块级兄弟。产出仍是 `buildChipsInput` 老形状（`selection` + `paragraphBefore/Current/After` 纯字符串），**AI 契约零改动**。
3. **工具栏定位**：选区 rect 是 iframe 内坐标 → **加该 section iframe 在主视口的偏移**（`iframe.getBoundingClientRect()`）→ viewport 坐标。`SelectionToolbar`（fixed）照旧消费 `store.selection.rect`。
4. **CFI 落点**：`section.cfiFromRange(range)` → `SelectionInfo.cfiRange`（存起来服务未来 RA3 标注；**AI chips 不需要 CFI**，`buildChipsInput` 不动）。
5. **清除**：iframe 文档 `selectionchange` 折叠/点别处 → `setSelection(null)`。section 卸载时摘除监听。

> 净效果：`SelectionToolbar`/`useAiActions`/`AIPanel`/`Composer`/`reader-store` 的 AI 部分**一行不改**。

---

## 5. 组件 / 接口 改动清单（供 plan 派生）

**主进程**

- `src/shared/ipc.ts`：新增 `libraryReadEpubBytes: "library:read-epub-bytes"`。
- `src/main/ipc/library-handlers.ts`：新增 handler（`bookIdInput` → `readFile(getBook(db,bookId).path)` → `Uint8Array`；缺书抛可读错误）。

**preload**

- `src/preload.ts`：`library.readEpubBytes(input: BookIdInput): Promise<Uint8Array>`；补 `progress.get(input: BookIdInput)` / `progress.save(input: SaveProgressInput)`（既有 IPC，竖切未暴露）。

**渲染层 · 纯逻辑（headless 可测，先写先测）**

- `src/renderer/reader/virtual-window.ts`：`computeWindow(scrollTop, viewportH, heights, count, estimate, overscan)` + `offsetOf`/`totalHeight` + 锚定增量计算。**最险逻辑、纯函数、重点测**。
- `src/renderer/reader/chapter-id-by-href.ts`：`(chapters, href) => id | null`。
- `src/renderer/reader/prefs-to-css.ts`：`(prefs) => cssString`。

**渲染层 · DOM/epub.js（手测）**

- `src/renderer/reader/VirtualizedReader.tsx`：滚动容器 + 用 `computeWindow` 管窗口 + 滚动/CFI/进度/跳章/当前章接线。
- `src/renderer/reader/SectionFrame.tsx`：单 section iframe（`section.load` → srcdoc + 偏好样式注入 → 测量 → 选区监听）。
- `src/renderer/reader/epub-book.ts`：`ePub(bytes)` 加载 + spine/CFI 辅助封装（含 `useQuery` 取字节）。
- `src/renderer/reader/epub-selection.ts`：从 section iframe 提取 `SelectionInfo`（块级取段 + iframe→viewport 坐标 + `cfiFromRange`）。

**渲染层 · 改/删**

- 改 `src/renderer/types.ts`：`SelectionInfo` 加 `cfiRange: string | null`。
- 改 `src/renderer/reader/ReaderView.tsx`：`ReaderPane` → `VirtualizedReader`。
- 改 `src/renderer/query/keys.ts`：加 `qk.epubBytes(bookId)`（`staleTime: Infinity`）；`qk.chapter`（旧显示用查询）随删除而废弃。
- 删 `src/renderer/reader/ReaderPane.tsx` + `src/renderer/reader/useSelection.ts`。

**依赖**

- 装 `epub.ts`（首选，全类型）或 `epubjs` + 最小 `d.ts`（plan 安装时核对确切包名与类型质量）。纯 JS 无原生。
- ⚠️ **ABI**：`pnpm add` 会把 better-sqlite3 重编为 Node ABI → 装完跑 `pnpm db:rebuild:electron` 翻回 Electron ABI（CLAUDE.md 既有坑）。

---

## 6. 错误处理（不静默）

| 场景                     | 处理                                                   |
| ------------------------ | ------------------------------------------------------ |
| `readEpubBytes` 失败     | IPC 抛可读错误 → 显错误态 + 「返回书库」，不空白       |
| epub.js 解析失败（坏书） | catch → 显「无法渲染此书」+ 原因，不崩                 |
| 单 section `load` 失败   | 该 section 显占位错误块（保留估高），不挡其余滚动      |
| 进度恢复 CFI 失效        | `spine.get(cfi)` 失败 → 从头显示，不挡阅读             |
| 选区上下文提取失败       | best-effort → 退化为只发选中文本，绝不静默吞掉 AI 提问 |
| ePub 内资源缺失          | epub.js 逐资源处理（缺图占位），阅读继续               |

---

## 7. 测试策略（虚拟化把最险逻辑变得可测）

- **可 headless 测的纯单元（重点，本轨测试主力）**：
  - `virtual-window`：给定 `scrollTop`/视口/高度缓存/估高/overscan → 断言挂载集合、offsets、totalHeight、滚动锚定增量。**这是 RA1-full 最险的逻辑，纯函数化后可充分覆盖**（边界：首/尾、未测高度、prefs 改后重算、空书）。
  - `prefsToCss`、`chapterIdByHref`：纯映射。
  - `readEpubBytes` handler（主进程 + `:memory:` + fixture：返字节 / 缺书抛错）。
- **手测检查点**（`pnpm start`，DOM/iframe/CFI/选区强依赖浏览器，无 DOM 不可 headless——同既有 ReaderPane/useSelection，`vertical-slice` §9 已认可）：真书渲染（排版/图片）· **连续滚动顺滑、长书内存有界（开 DevTools 看 DOM 节点/内存不随滚动无界涨）** · 跳章 + 当前章高亮 · 重开恢复位置 · 偏好实时生效 · 真实渲染上端到端 AI · 各错误态。

---

## 8. 刻意推迟（不在 RA1-full）

子 section 切块（超大单 spine 项的 intra-section 虚拟化；本轨按 section 粒度，超大单章会挂一个大 iframe——少见边界，先接受）· 标注渲染/持久化（RA3+M-b，`cfiRange` 已备）· 分页/翻页模式 · 搜索 · 暗色主题 · chip/消息「跳回原文」· 跨章选区→独立会话（M-c/RA4）· 嵌套 TOC · 章内字符级 ranges（标注用，留 RA3）· **foliate-js 等替代基座**（本轨已选 epub.js 作库 + 自造虚拟化；若后续虚拟化质量/CFI 成本超预期，再评估换基座）。

> **已评估不采纳：[pretext](https://github.com/chenglou/pretext)**（纯文本测量/排版库，canvas 预算文本高度、不触发 reflow）。不适配本轨：ePub section 是书自带的**外来 HTML+CSS+图片**（须 iframe 忠实渲染），而 pretext 只测「已知字体/宽度/行距的受控文本」、明说不做完整 CSS/图片排布——故无法预算外来 section 的渲染高度，「渲染后测量 + 滚动锚定」仍不可省。仅当改走「放弃 iframe、抽纯文本 + 受控样式自渲」（丢失真实排版/图片，退回 RA1-min++）时 pretext 才适用——非本轨目标。

---

## 9. 落地后流程与分期（风险递增排序）

```
本 spec → writing-plans（bite-sized 计划） → subagent-driven 实现
```

建议实现分期（plan 据此细化，每期一个手测检查点）：

1. **主进程 `readEpubBytes` + preload 接线**（含 progress）——headless 测 handler。
2. **`virtual-window` 纯逻辑 + 测试**（先把最险的窗口/锚定数学测扎实，再接 DOM）。
3. **`VirtualizedReader` + `SectionFrame` 基础渲染**：估高窗口化挂载真 section（手测：真书内容、连续滚动、内存有界）。
4. **测量 + 滚动锚定**：接实测高度 + 锚定校正（手测：滚动不跳、长书顺滑）。
5. **CFI 进度 + 恢复 + 跳章 + 当前章**（手测：跳章、重开恢复）。
6. **偏好注入 CSS**（手测：字号/行距/栏宽实时生效）。
7. **选区桥 + RA2 迁移**（手测：真实渲染上端到端 AI）。
8. **错误态收尾** + 删 ReaderPane/useSelection。
