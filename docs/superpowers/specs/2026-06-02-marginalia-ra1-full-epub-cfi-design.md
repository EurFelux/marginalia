# Marginalia · RA1-full（epub.js 真实渲染 + CFI 锚定）设计文档

> 状态：设计已确认，待落实施计划
> 日期：2026-06-02
> 轨道：**渲染层轨（RA）· RA1-full**——用 epub.js 把当前 RA1-min 的「静态纯文本渲染」升级为真实 ePub 渲染（HTML/CSS/图片）+ CFI 锚定（进度与未来标注的基础）。
> 上游：[`core-reading-loop-design`](2026-05-31-marginalia-core-reading-loop-design.md)（epub.js `flow:"scrolled"`、CFI 进度、章节以 spine 项为单位 + `chapters.id` 代理键经 `(bookId,href)` 解析）、[`vertical-slice-design`](2026-06-01-marginalia-vertical-slice-design.md)（RA1-min/RA2 现状）。
> 路线图：[`ROADMAP`](../ROADMAP.md)（RA1-full = RA3 标注前置、解锁面最大）。

---

## 1. 目标与非目标

**目标**：渲染层用 **epub.js** 渲染真实 ePub（保留排版/图片/结构），**全书连续滚动**；当前阅读位置与选区以 **CFI** 锚定，打通 **CFI 进度存取**；把 RA2 的选区→AI 链路从「静态 DOM + 字符偏移」迁到「epub.js iframe + CFI」，**AI 契约零改动**。

**成功判据**：导入的书以真实排版/图片连续滚动阅读；ChapterList 跳章、当前章高亮；重开恢复到上次位置；阅读偏好实时生效；在真实渲染上划选仍能触发工具栏→chips→真模型流式回复。

**非目标（刻意推迟，见 §6）**：标注渲染/持久化（RA3+M-b，但本轨已捕获并存 `cfiRange`）· 分页/翻页模式（只做 scrolled）· 搜索 · 暗色主题切换 · chip/消息「跳回原文」· 跨章选区→独立会话（RA4）· 嵌套 TOC 渲染。

---

## 2. 设计决策（拍板表）

| #   | 决策点                 | 结论                                                                                                                                            |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | epub.js 取数与渲染边界 | **A·渲染层 epub.js 全权**：新 IPC 把整本 ePub 字节给渲染层，`ePub(arrayBuffer)` 自管解析/资源/渲染/CFI                                          |
| 2   | 渲染与导航粒度         | **B·全书连续滚动**：epub.js `manager:"continuous"` + `flow:"scrolled"`，整本无缝滚动（continuous manager 自带视窗化懒渲染）；ChapterList 跳位置 |
| 3   | 主进程角色             | **仍是 AI 内容权威**：`content.chapterText`/`readChapterText` 工具/章节摘要照旧从字节抽纯文本；epub.js **只负责显示**                           |
| 4   | 选区生产者             | 用 epub.js 原生 `rendition.on("selected")`；**下游 AI 链路（工具栏/chips/composer/面板）一行不改**，只换生产者                                  |
| 5   | CFI 用途               | 本轨只服务**进度**；`SelectionInfo.cfiRange` 存起来供未来 RA3 标注锚定。**AI chips 仍走纯文字**，不threading CFI                                |

**关键洞察**：epub.js 是天生的渲染层库（解析 + 渲染 + CFI 都在渲染层）。`core-reading-loop` spec §3 已认可「ePub 渲染在 renderer（唯一有 DOM 处）」这一**主进程厚原则的既定破例**。本轨把「渲染层变厚」严格限定在**显示**这一处——业务（AI 上下文、摘要、密钥、DB）仍全在主进程。

---

## 3. 架构与数据流

### 3.1 取数（新 IPC）

新增 `library.readEpubBytes(bookId) → Uint8Array`：主进程读 `books.path` 返回字节（与 `send-deps.ts` 的 `createLoadBytes` 同一 `readFile(books.path)` 模式；可复用或就地三行读取）。渲染层**开书时一次性**取整本字节喂 `ePub(arrayBuffer)`。（ePub 体积通常数 MB ~ 数十 MB，一次性传输可接受；continuous manager 之后懒渲染 section。）

### 3.2 渲染（新组件 `EpubView`，替换 `ReaderPane`）

```ts
const book = ePub(bytes);
const rendition = book.renderTo(elRef.current, {
  flow: "scrolled",
  manager: "continuous",
  width: "100%",
  height: "100%",
});
await rendition.display(startCfiOrUndefined);
```

epub.js 全权：spine 顺序、资源（图片/CSS/字体从内存 ePub 加载）、CFI、连续视窗化。

### 3.3 导航 + 进度 + 当前章

- **跳章**：ChapterList 点击 → `rendition.display(chapterHref)`（在连续流里定位到该章）。
- **当前位置**：`rendition.on("relocated", (loc) => …)` → 当前 CFI（`loc.start.cfi`）+ `loc.start.href` → 经纯函数 `chapterIdByHref(chapters, href)` 映射到 `chapters.id` → ① 高亮 ChapterList 当前章（写 `setCurrentChapter`）② **防抖**保存进度。
- **进度存取**：接通既有 `progress.save({bookId, cfi})` / `progress.get(bookId)` IPC（竖切未接，本轨接上 preload + 渲染层）。开书时若有存档 CFI → `display(cfi)` 恢复；无则从头。

### 3.4 阅读偏好 → epub.js themes

`fontScale`/`lineHeight`/`maxWidth`（`reader-store.prefs`）经纯函数 `prefsToTheme(prefs)` 映射为 `rendition.themes.default({...})`（字号 %、行距、正文 `max-width`/`margin`）。替换现在 article 的内联 style。偏好变更 → 重新 `themes.fontSize()/override()`。

### 3.5 数据流一句话

`主进程字节 → 渲染层 epub.js 渲染显示 + CFI；AI 上下文/摘要仍走主进程纯文本`。CFI 这条新线只服务**进度**与（未来 RA3 的）**标注锚定**。

---

## 4. 选区桥接（RA2 迁移）

epub.js 把每个 section 渲染在 **iframe** 里，选区发生在 iframe 文档内。整条 AI 链路保持不变，**只换"选区生产者"**：删 RA1-min 的 `useSelection`（作用于静态 DOM）+ ReaderPane 的 `data-paragraph` 标记；新增 epub.js 选区桥。

1. **捕获**：`rendition.on("selected", (cfiRange, contents) => …)`（用户在正文 mouseup 出非折叠选区时触发）。`contents` 给该 section 的 `document`/`window`。
2. **上下文提取**：`rendition.getRange(cfiRange)` 拿 iframe 内 DOM Range，复用取段逻辑但**作用在 `contents.document`**。⚠️ iframe 里是**书的原生 HTML**，没有 `data-paragraph` 标记——`paragraphOf` 改为「取选区最近的块级祖先（`p/div/li/blockquote/section…`）」，前/后段取其相邻块级兄弟。产出仍是 `buildChipsInput` 老形状（`selection` + `paragraphBefore/Current/After` 纯字符串），**AI 契约零改动**。
3. **工具栏定位**：选区 rect 是 iframe 内坐标，须**加 iframe 在主视口的偏移**翻译成 viewport：`range.getBoundingClientRect()` + `iframe.getBoundingClientRect()`。`SelectionToolbar`（fixed）照旧消费 `store.selection.rect`。
4. **CFI 落点**：`SelectionInfo` 新增 `cfiRange: string | null`，存起来服务进度跳转与未来 RA3 标注；**RA1-full 的 AI chips 不需要 CFI**（`buildChipsInput` 不动）。
5. **清除**：监听 `contents.document` 的 `selectionchange`，折叠/点别处即 `setSelection(null)` 收起工具栏（沿用现逻辑）。section 渲染时挂监听（`rendition.on("rendered", (section, view) => …)`），视图卸载时摘除。

> 净效果：`SelectionToolbar`/`useAiActions`/`AIPanel`/`Composer`/`reader-store` 的 AI 部分**一行不改**；只把「选区从哪来」从静态 DOM 换成 epub.js iframe。

---

## 5. 组件 / 接口 改动清单（供 plan 派生）

**主进程**

- `src/shared/ipc.ts`：新增 `libraryReadEpubBytes: "library:read-epub-bytes"`。
- `src/main/ipc/library-handlers.ts`：新增 handler（`bookIdInput` → `readFile(getBook(db,bookId).path)` → `Uint8Array`；缺书抛可读错误）。

**preload**

- `src/preload.ts`：`library.readEpubBytes(input: BookIdInput): Promise<Uint8Array>`；并补 `progress.get(input: BookIdInput)` / `progress.save(input: SaveProgressInput)`（既有 IPC，竖切未暴露）。

**渲染层**

- 新增 `src/renderer/reader/EpubView.tsx`：epub.js rendition 容器（取字节 → 渲染 → display/relocated/themes/进度）。
- 新增 `src/renderer/reader/epub-selection.ts`：选区桥（`rendition.on("selected")` → 提取 → `setSelection`），含块级取段 + iframe→viewport 坐标。
- 新增纯函数 `src/renderer/reader/chapter-id-by-href.ts`（`(chapters, href) => id | null`）+ `src/renderer/reader/prefs-to-theme.ts`（`prefs => themeObject`）——可 headless 测。
- 改 `src/renderer/types.ts`：`SelectionInfo` 加 `cfiRange: string | null`。
- 改 `src/renderer/reader/ReaderView.tsx`：`ReaderPane` → `EpubView`。
- 删 `src/renderer/reader/ReaderPane.tsx` + `src/renderer/reader/useSelection.ts`（被 EpubView + 选区桥取代）。
- 新增 query key `qk.epubBytes(bookId)`：EpubView 用 `useQuery` 取字节（`staleTime: Infinity`，字节大、本地确定性，缓存到换书）。`qk.chapter`（旧 `content.chapterText` 显示用查询）随 ReaderPane 删除而废弃。

**依赖**

- 装 `epubjs`（渲染层依赖，纯 JS 无原生）。类型：epubjs 自带 d.ts 较弱，必要时加最小 `epubjs.d.ts` 补 `selected`/`relocated`/`getRange`/`themes` 等签名。
- ⚠️ **ABI**：`pnpm add` 会把 better-sqlite3 重编为 Node ABI → 装完跑一次 `pnpm db:rebuild:electron` 翻回 Electron ABI（CLAUDE.md 既有坑）。

---

## 6. 错误处理（不静默）

| 场景                          | 处理                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `readEpubBytes` 失败          | IPC 抛可读错误 → EpubView 显错误态 + 「返回书库」，不空白 |
| epub.js 解析/渲染失败（坏书） | catch → 显「无法渲染此书」+ 原因，不崩应用                |
| 进度恢复 CFI 失效             | `display(cfi)` reject → 兜底从头显示，不挡阅读            |
| 选区上下文提取失败            | best-effort → 退化为只发选中文本，绝不静默吞掉 AI 提问    |
| ePub 内资源（图片）缺失       | epub.js 逐资源处理，阅读继续                              |

---

## 7. 测试策略（诚实面对 DOM 绑定）

epub.js/iframe/CFI/选区**强依赖浏览器 DOM**，而 vitest 跑在 Electron-as-node（无 DOM）——故 `EpubView` 与选区桥**主体不可 headless 测**（同现有 ReaderPane/useSelection，`vertical-slice` spec §9 已认可）。

- **可 headless 测的纯单元**（抽出来测）：`readEpubBytes` handler（返字节 / 缺书抛错；主进程 + `:memory:` + fixture）· `chapterIdByHref(chapters, href)` 纯映射 · `prefsToTheme(prefs)` 纯映射 · 进度防抖逻辑（可纯函数化）。
- **手测检查点**（`pnpm start`）：真 ePub 渲染（排版/图片）· 全书连续滚动 · ChapterList 跳章 + 当前章高亮 · 重开恢复进度 · 偏好实时生效 · 真实渲染上选区→工具栏→AI 提问 · 各错误态。

---

## 8. 刻意推迟（不在 RA1-full）

标注渲染/持久化（RA3+M-b；`cfiRange` 已备）· 分页/翻页模式 · 搜索 · 暗色主题切换 · chip/消息「跳回原文」（CFI 暂只存不用）· 跨章选区→独立会话（M-c/RA4）· 嵌套 TOC 渲染 · 章内字符级 ranges（标注用，留 RA3）。

---

## 9. 落地后流程

```
本 spec → writing-plans（bite-sized 计划） → subagent-driven 实现
```

实现顺序建议：先**主进程 `readEpubBytes` + preload 接线**（含 progress）→ **`EpubView` 基础渲染 + 字节取数**（手测：真书渲染 + 滚动）→ **导航/当前章/进度**（手测：跳章 + 恢复）→ **偏好 themes** → **选区桥 + RA2 迁移**（手测：真实渲染上端到端 AI）→ **错误态收尾**。
