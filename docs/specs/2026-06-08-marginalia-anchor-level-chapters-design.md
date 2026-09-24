# Marginalia · 锚点级章节（intra-section anchor chapters）设计文档

> 状态：设计已确认（用户认可，待落实施计划）
> 日期：2026-06-08
> 轨道：阅读核心闭环修复 + RA 轨延伸——把「章节」从 **spine 文件**重新定义为 **TOC 条目（href + anchor）**，支持「整本塞进少数大 HTML、靠 `#fragment` 锚点切章」的常见 ePub（Calibre / Epubor 导出）。
> 上游：[`core-reading-loop-design`](2026-05-31-marginalia-core-reading-loop-design.md)、[`ra1-full-epub-cfi-design`](2026-06-02-marginalia-ra1-full-epub-cfi-design.md)（本 spec 解冻其 §8 刻意推迟的「嵌套 TOC / 子 section 切块 / 章内锚点」）。

---

## 0. 问题陈述（取证结论）

样本书《早起的奇迹》（`~/Downloads`，Epubor 导出 EPUB2）解析不到章节名，Apple Books 却能完整显示。取证：

- **spine 只有 2 个文件**：`text00000.html`、`text00001.html`（`content.opf` 的 `<spine>` 仅 2 个 `itemref`）。
- **`toc.ncx` 有 61 个 `navPoint`**，真实章节名俱全，但 `content src` 全部指向这 2 个文件的不同 `#filepos` 锚点（去锚点后：`text00000.html` × 44、`text00001.html` × 17）。
- 锚点在 HTML 中是**真实元素 id**：`<span id="filepos0000044175">…`（共 70 个 `id="filepos…"`，无老式 `<a name>`）。

**根因（贯穿三层）**：

1. **解析剥锚点**：`packages/epub-parser/src/parse.ts` 读 NCX（`:154`）与 EPUB3 nav（`:126`）时 `.split("#")[0]` 丢掉 fragment → 61 个 TOC 条目的 href 塌缩成 2 个。
2. **导航列表去重**：`src/main/library/content.ts` 的 `listChapters`（`:124` `seen.has(ch.id)`）按 spine 文件去重 → 61 章只剩 2 条（仅显示每文件首个 label）。
3. **AI 章节单元 = spine 文件**：`chapters` 表 1 行 = 1 个 spine 文件，章节摘要/读章把整个 `text00000.html` 当一章。

**附带通用 bug（同一能力缺口）**：`packages/virtual-docs/src/SectionFrame.tsx` 的 iframe 为 `sandbox="allow-same-origin"` + `srcDoc`（base URL = `about:srcdoc`），`click` 监听 `onAnnoClick`（`:115`）**只处理 `[data-anno-id]`、不拦截普通 `<a>`**。点击文内 `<a href="text00000.html#filepos…">` → 浏览器默认导航 → iframe 把自己导向相对 `about:srcdoc` 解析出的无效地址 → **iframe 变空白 = 白屏**。凡带文内链接（脚注 / 交叉引用 / 正文目录）的 ePub 皆中招。正确修法（拦截 `<a>` → 站内转应用内锚点跳转、外链开外部浏览器）即本设计的锚点导航组件。

---

## 1. 目标与非目标

**目标**：把「章节」重定义为 **TOC 条目**，使锚点切章的书在「章节列表显示 / 跳章 / AI 章节单元 / 当前章高亮 / 进度恢复」全链路按锚点工作；顺带修掉文内链接白屏。**渲染端 2 个大 iframe 的 section 渲染本身不变**——锚点逻辑是叠加在其上的 nav / 定位层。

**成功判据**：

- 《早起的奇迹》章节列表显示全部 61 个真实章节名（含层级，若 TOC 有嵌套）。
- 点击章节 / 点击文内站内链接 → 精确滚到对应 `#filepos` 锚点（不再跳文件顶、不再白屏）；外链开系统浏览器。
- AI `getToc` 返回 61 个锚点章，逐章可读、可摘要，章节正文按「本锚点 → 下一锚点」切分。
- 当前章高亮随滚动落到所在锚点章（不再恒停文件首章）；重开恢复到上次锚点。
- 存量已导入的此类书重开即自动升级（无需重导）。
- 普通「1 spine = 1 章」的书行为不回归（anchor 为空时退化为现状）。

**非目标（刻意推迟）**：分页 / 翻页模式 · 搜索 · 章内字符级标注 ranges（RA3 已覆盖标注主线，本 spec 不改标注） · 跨 spine 跨章选区→独立会话（RA4） · 把杂项前置章（书名页/版权页/目录）从列表中过滤（保留列出，仅靠「自动摘要默认关」避免烧 token）。

---

## 2. 设计决策（拍板表）

| #   | 决策点           | 结论                                                                                                                                 |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 「章节」定义     | **= TOC 条目（href + anchor）**，单一真相源；AI / 进度 / 摘要 / 高亮全 key 在 chapter 行上                                           |
| 2   | chapters 表      | 1 行 = 1 个 TOC 条目（含 `anchor`、`level`）；唯一约束 `(bookId, href, anchor)`。无 TOC 的书退回 spine 顺序（anchor 为 null）        |
| 3   | 渲染粒度         | **section（spine 文件）渲染不变**（仍 N 个 iframe）；锚点是 section 内的定位/分段，不拆 iframe                                       |
| 4   | TocNode 形态     | href 仍存**裸 spine 路径**，新增 `anchor?: string \| null`（避免下游各处再 split）                                                   |
| 5   | 存量书升级       | `books.parserVersion`；开书时低于当前版本 → 从磁盘字节**惰性重建** `toc` + `chapters`（文件丢失跳过 + warn）。不做启动期全库批量迁移 |
| 6   | 内容切分         | 章节正文 = 本 anchor（含）到**同文件下一边界 anchor**（不含）之间的块级文本；anchor 为 null 退化为整文件                             |
| 7   | 全书正文（摘要） | `readBookText` 按 href **去重**迭代（多锚点章共享 href，防重复抽取）                                                                 |
| 8   | 文内链接         | `SectionFrame` 拦截 `<a>` click → `preventDefault`；站内 → `onInternalLink`，外链 → `onExternalLink` → 主进程 `shell.openExternal`   |
| 9   | 当前章 / 进度    | 锚点级：视口顶部所在边界锚点 → 高亮 + 存 CFI；恢复 = section index + 滚到锚点                                                        |

**关键洞察**：① `listChapters` 本就「以 TOC 为准」，问题不在它的意图而在上游 href 被剥锚 + 它自身按文件去重。把 chapters 表对齐 TOC 后，去重逻辑天然消失。② 锚点全是真实元素 id，浏览器原生 `getElementById` + epubjs `EpubCFI` 即可精确定位，无需自造。③ 渲染（iframe）与导航（锚点）是两个关注点，本就分离——只动导航层，渲染零改动，风险收敛。

---

## 3. 架构与数据流

### 3.1 解析层（`packages/epub-parser`）

- `types.ts`：`TocNode` 增 `anchor?: string | null`。
- `parse.ts` `readToc`：
  - NCX（`:152-157` `toNode`）：`src.split("#")` → `href = 文件路径`、`anchor = fragment ?? null`，二者分别落 `TocNode`。
  - EPUB3 nav（`:121-134`）：同理拆 `a.getAttribute("href")` 的 `#fragment`。
- `content.ts`：
  - 新签名 `extractChapterText(bytes, href, opts, anchor?, nextAnchor?)`（PDF 路径不变）。算法见 §3.4。
  - `extractBookText(bytes, hrefs, opts)`：调用方传**去重后**的 hrefs（本层不变，去重在 `content.ts` 消费侧 §3.5）。

### 3.2 数据模型（`src/main/db/schema.ts`）

- `chapters`：增 `anchor: text("anchor")`（nullable）；唯一约束 `unique().on(t.bookId, t.href, t.anchor)`（取代 `(bookId, href)`）。
- `books`：增 `parserVersion: integer("parser_version")`（默认 0 / null = 旧），当前解析器版本常量 `CURRENT_PARSER_VERSION`。
- `pnpm db:generate` 生成迁移；**注意 drizzle 表重建 FK 事务坑**（见 [[drizzle-migrate-fk-transaction-gotcha]]）：表重建 DROP 撞子表 FK，`runMigrations` 须在事务外切 `foreign_keys`。
- SQLite `UNIQUE` 对 `NULL` 不去重（多个 anchor=null 行不冲突）——对「无 TOC 退回 spine」场景天然安全；锚点章 anchor 非空、正常受唯一约束。

### 3.3 导入 + 惰性重建索引（`src/main/library/repository.ts`）

- `importEpubBook`：`tocLabelByHref` 路线改为**直接按 TOC 条目建 chapters**——遍历 `parsed.toc`（含 children，保 `level` / `orderIndex`），每条插一行 `{ href, anchor, title: label, orderIndex, ... }`。无 TOC 时退回 spine 顺序（anchor=null，title=null）。写入 `books.parserVersion = CURRENT_PARSER_VERSION`。
- `resolveChapterByHref` → `resolveChapter(db, bookId, href, anchor)`：按 `(bookId, href, anchor)` 解析（anchor 为 null 时匹配 null 行）。
- **惰性重建** `reindexBookIfStale(db, bytes, bookId)`：开书取字节后，若 `book.parserVersion < CURRENT_PARSER_VERSION` → 重 `parseEpub(bytes)` → 事务内 `DELETE chapters WHERE bookId` + 重插 + 重写 `books.toc` + `books.parserVersion`。**幂等**；文件缺失（调用方取不到字节）→ 跳过 + warn，不阻塞开书。**已核实**（`schema.ts`）：`annotations` / `progress` / `conversations` 全部 FK 挂 `books.id`（cascade），**无任何表挂 `chapters.id`**——标注锚在 `cfiRange` + `bookId`，故 `DELETE chapters WHERE bookId` 重建只重排 chapters 行，绝不级联误删标注/进度/会话。

### 3.4 内容切分算法（`extractChapterText`，§3.1）

给定 `(href, anchor, nextAnchor?)`：

1. 解压取 spine 文件 HTML，`node-html-parser` 解析。
2. 定位边界：`startEl = 含 id===anchor 的元素`；`endEl = 含 id===nextAnchor 的元素`（缺 nextAnchor = 到文件末）。
3. 取「本章块级文本」：沿用 `htmlToText` 的块级收集口径（`h1-6/p/li/blockquote/pre/figcaption`），但只保留**源码位置落在 `[startEl, endEl)` 区间**的顶层块（用 node-html-parser 的元素 `range`/document order 比较）。
4. `anchor == null` → 退化为现有「整文件 `htmlToText`」。
5. 分页（offset/maxChars）在切出的章文本上做，与现有 `extractChapterText` 一致。

边界鲁棒性：边界 `<span id>` 常内嵌于段首 → 以「包含该 id 的最近块」为起始块（含）。锚点章正文与渲染 iframe 文本口径同源（都走 `htmlToText`），与 CFI / 选区抽段不冲突。

### 3.5 导航/AI 消费层（`src/main/library/content.ts`、`src/main/ai/tools.ts`）

- `listChapters`：遍历 `getToc()`，每个有 `label` 的节点 → `resolveChapter(db, bookId, n.href, n.anchor)` → push（`level` 来自 TOC 深度）。**移除按 spine 文件去重**（锚点不同即不同章）；保留「同一 (href,anchor) 防重复」即可。
- `ChapterRefDto`（`src/shared/library.ts`）增 `anchor: string | null`。
- `readChapterText`：取目标 chapter 行的 `(href, anchor)` + **同文件下一边界 anchor**（按 orderIndex 取同 href 的下一行 anchor）→ 传 `extractChapterText`。
- `readBookText`：`select distinct href ... order by orderIndex`（去重，§2.7）。
- `ai/tools.ts`：`getToc` / `summarizeChapter` / `readChapter` 经上述函数天然按锚点章工作；章节摘要存 `chapters.summary`（锚点章各自一行，天然分摘要）。**自动摘要默认关**（[[onboarding-guide-auto-summary]]），不会开书即烧 61 次。

### 3.6 渲染端（`packages/virtual-docs` + `src/renderer/reader`）

**`packages/virtual-docs/src/SectionFrame.tsx`（修白屏 + 链接桥）**：

- 新增 `<a>` click 拦截（与 `onAnnoClick` 并存）：`const a = target.closest("a[href]")`；命中则 **`e.preventDefault()`**，按 href 分流：
  - 纯 fragment（`#x`，同 section）→ 直接 `doc.getElementById(x)?.scrollIntoView()`（或交消费方统一走 `scrollToAnchor`）。
  - 站内 path[#frag]（相对、非 http）→ `onInternalLink({ index, href })`。
  - 外链（`http(s):` / `mailto:`）→ `onExternalLink(url)`。
- 新 props：`onInternalLink?(e)`、`onExternalLink?(url)`，经 `VirtualDocs` 透传。

**`packages/virtual-docs/src/VirtualDocs.tsx`**：`VirtualDocsHandle` 增 `scrollToAnchor(index, anchorId)`——先 `scrollToIndex(index)`，待该 section iframe 就绪后按 `getElementById(anchorId).offsetTop` 叠加偏移精确定位（就绪时序：复用现有「iframe load + 测高」信号；未就绪先滚 section、加载后补滚锚点）。

**`src/renderer/reader/epub-book.ts`**：`indexOfHref` 保持（已 `split("#")[0]`，返回 section index）；anchor 定位交 VirtualDocs 的 DOM 偏移 + epubjs `EpubCFI`（`cfiFromElement` 算锚点元素 CFI 供进度）。

**`src/renderer/reader/EpubReader.tsx`**：

- **跳章**（`:117`）：`ch.anchor ? vRef.scrollToAnchor(idx, ch.anchor) : scrollToIndex(idx)`。
- **文内链接**：接 `onInternalLink`（resolve href→(index,anchor)→`scrollToAnchor`）、`onExternalLink`（→ 新 IPC `app:open-external` → 主进程 `shell.openExternal`，§3.7）。
- **当前章（锚点级）**：滚动时除 `onTopIndexChange(index)` 外，算视口顶部所在边界锚点（读可见 section iframe 内各边界 anchor 的 offsetTop vs 滚动位置）→ `chapterIdByHref` 升级为 `resolveCurrentChapter(chapters, href, anchorId)` → `setCurrentChapter`。
- **进度**（`:154-182`）：`cfiAtIndex` 升级为「视口顶部锚点的 CFI」；恢复（`:123` `indexOfCfi`）→ section index + 锚点滚动。

### 3.7 主进程：外链（`src/preload.ts` + IPC）

- 新增 IPC `app:open-external`（input: `{ url: string }`）；handler 校验协议白名单（`http/https/mailto`）后 `shell.openExternal(url)`，拒绝 `file:` 等。复用既有 i18n `streamdown.openExternalLink`（外链确认 UX，若需确认弹窗）。

### 3.8 数据流一句话

`字节 → 解析保锚点（toc 带 anchor）→ chapters 表 = TOC 条目（含 anchor）→ AI/导航/进度按 (href,anchor) 工作；渲染仍按 spine 出 iframe，锚点用 getElementById/CFI 在 section 内定位`。

---

## 4. 模块改动清单（供 plan 派生）

**`packages/epub-parser`**

- `src/types.ts`：`TocNode` 增 `anchor`。
- `src/parse.ts`：`readToc` 的 NCX + EPUB3 nav 拆 `href`/`anchor`，停止剥锚。
- `src/content.ts`：`extractChapterText` 增 `anchor`/`nextAnchor` 切分；新增锚点区间块级收集。

**`src/shared`**

- `types.ts`：`tocNodeSchema` 增 `anchor: z.string().nullable().optional()`。
- `library.ts`：`ChapterRefDto` 增 `anchor: string | null`。
- `ipc.ts`：新增 `appOpenExternal: "app:open-external"`（+ input schema）。

**`src/main`**

- `db/schema.ts`：`chapters.anchor`、唯一约束改 `(bookId,href,anchor)`、`books.parserVersion`；`CURRENT_PARSER_VERSION` 常量。
- `db/migrations`：`pnpm db:generate`（注意 FK 事务坑）。
- `library/repository.ts`：导入按 TOC 建 chapters、`resolveChapter(href,anchor)`、`reindexBookIfStale`。
- `library/content.ts`：`listChapters` 去掉文件去重、`readChapterText` 传 anchor+nextAnchor、`readBookText` href 去重、开书路径调用 `reindexBookIfStale`。
- `ai/tools.ts`：经上述自然按锚点章工作（核对 `getToc`/`readChapter`/`summarize` 引用）。
- `ipc/app-handlers.ts`（或对应胶水）：`app:open-external` handler（协议白名单 + `shell.openExternal`）。

**`packages/virtual-docs`**

- `src/SectionFrame.tsx`：`<a>` click 拦截 + `onInternalLink`/`onExternalLink`。
- `src/VirtualDocs.tsx`：`VirtualDocsHandle.scrollToAnchor`、透传链接回调。

**`src/renderer/reader`**

- `epub-book.ts`：锚点元素 CFI 辅助（`cfiFromElement`/锚点 offset）。
- `chapter-id-by-href.ts`：升级为锚点感知的 `resolveCurrentChapter`。
- `EpubReader.tsx`：跳章/文内链接/当前章/进度接线（§3.6）。
- `preload.ts`：`api.app.openExternal`。

---

## 5. 错误处理（不静默）

| 场景                             | 处理                                               |
| -------------------------------- | -------------------------------------------------- |
| 锚点元素缺失（坏 id / 改版书）   | 退回 section 顶滚动 + `log.warn`，不白屏不崩       |
| `reindexBookIfStale` 取不到字节  | 跳过重建（保留旧 chapters）+ `log.warn`，照常开书  |
| TOC 节点 zod 校验失败            | 沿用 `getToc` 既有整条 prune + warn                |
| 内容切分定位不到 anchor          | 退化为整文件文本 + warn（AI 仍拿到内容，不静默空） |
| 外链协议不在白名单（`file:` 等） | 拒绝 + warn，不调 `shell.openExternal`             |
| 站内链接 resolve 不到 section    | no-op + warn（不导航、不白屏）                     |

---

## 6. 测试策略

**Headless 单测（vitest，纯函数 / `:memory:`）**：

- `parse.ts`：NCX + EPUB3 nav 保留 `anchor`（fixture 用《早起的奇迹》精简版：2 spine + 多 `#filepos`）。
- `content.ts`：`extractChapterText` 按 `(anchor, nextAnchor)` 正确切段（首章 / 中章 / 末章 / anchor=null 退化）。
- `repository.ts`：导入按 TOC 建 chapters（61 行）、`resolveChapter(href,anchor)`、`reindexBookIfStale` 幂等 + 版本门控 + 不误删标注。
- `content.ts` `listChapters`：61 章不塌缩、`level` 正确、`anchor` 透出；`readBookText` href 去重。
- `app:open-external` handler：协议白名单（放行 http、拒 file）。

**手测（DOM/iframe/CFI 强依赖，无法 headless——沿用 vertical-slice §9 认可）**：真书章节列表 61 名 · 点章跳准锚点 · **点文内链接不白屏 + 跳准** · 外链开系统浏览器 · 当前章随滚动走锚点 · 重开恢复到锚点 · 普通书不回归 · 存量书重开自动升级。

---

## 7. 落地分期（writing-plans 派生 bite-sized 计划）

```
本 spec → writing-plans → subagent-driven 实现
```

- **Plan A（headless / 主进程）**：解析保锚点（types+parse）+ schema 迁移（anchor / 唯一约束 / parserVersion）+ 导入按 TOC 建章 + 惰性重建索引 + 内容锚点切分 + `listChapters`/`resolveChapter` + `readBookText` 去重 + AI 工具核对 + 全套单测。**自洽可独立验证**（修复显示 + AI 单元两层）。
- **Plan B（渲染端，依赖 A）**：`app:open-external` IPC + `SectionFrame` 链接拦截（**修白屏**）+ `VirtualDocs.scrollToAnchor` + `EpubReader` 跳章/链接/当前章/进度接线 + `resolveCurrentChapter`。**手测为主**。

A 是 B 的前置（B 依赖 A 产出的 `anchor` 字段与锚点 toc）。两 Plan 各自 changeset。
