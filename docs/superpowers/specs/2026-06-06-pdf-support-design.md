# PDF 格式支持设计

日期：2026-06-06
状态：已与用户对齐，待实现
关联：新增格式轨道（PDF-P1 / P2 / P3）；本设计源于可行性评估（方案 A：双引擎并立 + 统一 Locator 抽象）

## 1. 背景与动机

Marginalia 目前只支持 ePub。用户的实际阅读材料中有相当比例是 PDF——文字版书籍、技术文档/手册，以及部分扫描版。期望 PDF 达到与 ePub 对齐的体验深度：渲染阅读 + 选区问 AI + 高亮标注 + 进度恢复 + 章节/全书摘要。

ePub 与 PDF 的根本分野是 **reflowable（流式）vs fixed-layout（固定版面）**：ePub 是打包的 HTML，文字可重排、可用 DOM Range/CFI 精确定位；PDF 是印刷指令集，内容是页面绘制操作。这决定了两者在定位、渲染、选区上不可共享实现，但 AI 链路（消费纯文本/图像）对格式透明。

## 2. 决策摘要

| 决策点        | 结论                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 总体方案      | **双引擎并立**：epubjs 与 pdfjs-dist 各管各的渲染；不造统一 `BookAdapter` 抽象（CFI 方法对 PDF 无意义，泛化只得一堆 null 实现）                                           |
| 定位          | **Locator 黑盒原则**：`progress`/`annotations` 定位串存储层不解释；ePub 继续存裸 CFI（既有数据零迁移转换），PDF 存 `pdf:` 前缀 + JSON                                     |
| 「章节」映射  | 有 outline → 每个 outline 项一章（压扁，记页范围）；**无 outline → 整本退化单章（标题取书名，避免 `title: null` 困惑模型）**；AI 工具 `getToc`/`readChapterText` 契约不变 |
| AI 工具       | **按 `book.format` 分发工具集**：PDF 额外暴露 `readPage(page, mode: "text" \| "image")`；image 形式供视觉模型直接读页面图像                                               |
| 扫描版        | 能看（canvas 渲染免费）；选区/标注/摘要禁用（无文本层）；**聊天问答经 `readPage(image)` 对视觉模型解锁**                                                                  |
| 主进程 canvas | 引入 `@napi-rs/canvas`（NAPI = ABI 稳定，**无需 electron-rebuild**）做页面渲染：readPage image 形式 + 导入时封面缩略图                                                    |
| 缩放          | v1 = 适宽默认 + 缩放档位（100%/125%/150% 等）；Ctrl+滚轮平滑缩放进 backlog                                                                                                |
| pdfjs 双端    | 主进程用 `pdfjs-dist/legacy/build/pdf.mjs`（Node 环境，官方支持路径）；渲染层用标准 build + vite worker                                                                   |
| 列重命名      | `progress.cfi` → `locator`、`annotations.cfiRange` → `locatorRange`（SQLite `RENAME COLUMN`，非表重建，绕开 FK 迁移坑）                                                   |

## 3. 总体架构

```
                    ┌─ format="epub" ─→ packages/epub-parser（现有）
导入: importBook ───┤
                    └─ format="pdf"  ─→ packages/pdf-parser（新，pdfjs-dist legacy）

                    ┌─ EpubReader.tsx ─ epubjs + VirtualDocs(iframe) ─ CFI
阅读: ReaderView ───┤  按 book.format 分发
                    └─ PdfReader.tsx ─ pdfjs-dist + Virtuoso(canvas+textLayer) ─ pdf locator

AI 链路（chips / 聊天 / 摘要 / 自动命名）：本体零改动；工具集按 format 分发（§7）
存储（progress / annotations）：locator 黑盒串，只有对应格式的 reader 解释
```

## 4. 数据模型（schema 变更）

```ts
books:
+ format: text("format", { enum: ["epub", "pdf"] }).notNull().default("epub")  // + CHECK 约束
+ pageCount: integer   // PDF 专用；epub 为 null
+ hasTextLayer: integer({ mode: "boolean" }).notNull().default(true)  // 扫描版检测；epub 恒 true

chapters:（PDF 的「章节」= outline 项）
+ startPage / endPage: integer  // PDF 专用页范围（1-based 闭区间）；epub 为 null
  href: PDF 存 "pdf-ch:<orderIndex>"  // 纯标识，满足现有 NOT NULL + UNIQUE(bookId, href)
        （注：两个 outline 项可指向同一起始页，故不能用页号作 href）

progress:
  cfi → locator（RENAME COLUMN）
  值：ePub = 裸 CFI 串（原样）；PDF = pdf:{"page":12,"scrollRatio":0.35}

annotations:
  cfiRange → locatorRange（RENAME COLUMN）
  值：ePub = 裸 CFI 区间串（原样）；PDF = pdf:{"page":12,"start":480,"end":527}
      // 页内文本流字符偏移（getTextContent items 顺序拼接后的偏移）
```

- 判别函数：`isPdfLocator(s) = s.startsWith("pdf:")`；非 `pdf:` 前缀即视为 CFI。
- **标注用字符偏移而非矩形坐标**：同一 PDF 文件的 `getTextContent` 输出确定，页内偏移稳定；既有 `selectedText` 快照天然成为重锚定兜底（pdfjs 升级万一改变提取结果时按文本搜索恢复）。绘制时偏移 → textLayer Range → 矩形 overlay。
- `books.id`：PDF 无 ePub 标识符，统一走现有回退路径 = 文件 SHA256 哈希。

## 5. 主进程

### 5.1 新包 `packages/pdf-parser`（对称 epub-parser，headless vitest 可测）

```ts
parsePdf(bytes): Promise<ParsedPdf>
// { title?, author?, pageCount, toc: TocNode[]（outline 转换，href="pdf-ch:<i>"）,
//   chapterRanges: { startPage, endPage }[], hasTextLayer: boolean }

extractPdfText(bytes, { startPage, endPage, offset?, maxChars? }): Promise<ChapterTextSlice>
// 页范围 getTextContent 拼接 → 字符偏移分页；输出形状与 ePub 的 extractChapterText 一致
// 页间插入轻量页边界标记（如 "\n\n[p.13]\n\n"）——模型可在章节文本中引用页码，
// 并据此跳转 readPage(n) 精读（粗读定位 → 精读看图的工作流闭环）

renderPageImage(bytes, page, { scale? }): Promise<Uint8Array>
// @napi-rs/canvas + pdfjs render → PNG；供 readPage(image) 与封面缩略图
```

- **outline → 页号**：outline 项 `dest` 经 `getDestination()` + `getPageIndex()` 异步解析为起始页；`endPage` = 下一项起始页 − 1（最后一项到 pageCount）。嵌套 outline 压扁（与现有 `content.chapters` 扁平现状一致；嵌套 TOC 渲染本就在 backlog）。
- **扫描版检测**：采样前 ~8 页 `getTextContent`，平均每页字符数低于阈值（~50，实现期校准）→ `hasTextLayer=false`。
- **连锁改动**：`parseEpub` 同步而 pdfjs 全异步 → `importBook` 签名变 async（IPC handler 本来就 await，波及面小）。
- **偏移空间注记（防实现期混淆）**：「页内偏移」（annotations locator 的 `start/end`，渲染层 textLayer 产生，不含任何标记）与「章内偏移」（`readChapterText`/`extractPdfText` 的 `offset`，含页边界标记）是**两个独立坐标空间**——各自自洽、互不转换，不存在跨空间换算需求。

### 5.2 既有模块改动

| 文件                    | 改动                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `library/repository.ts` | `importBook` 按**魔数嗅探**分发（`%PDF-` / zip 头，不信文件后缀）；`books.format` 落库；PDF 导入时 `renderPageImage(1)` 存封面 |
| `library/book-files.ts` | 副本后缀按格式（`.pdf` / `.epub`）；删书逻辑不变                                                                               |
| content-service         | `readChapterText` 按 `book.format` 分发到 `extractPdfText`（用 `chapters.startPage/endPage`）；摘要链路自动受益零改动          |

- 性能注：v1 每次提取重新 `getDocument`（对称 ePub 每次重解压）；「PDF 文档句柄缓存」进 backlog。

### 5.3 IPC 变更（`src/shared/ipc.ts` 契约单一源）

| 通道                      | 变更                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `library:pick-epub`       | → `library:pick-book`（对话框 filter epub+pdf）                        |
| `library:read-epub-bytes` | → `library:read-book-bytes`（语义泛化；仓库内同步改名，无兼容包袱）    |
| `progress:get/save`       | 字段 `cfi` → `locator`（input schema + DTO 同步）                      |
| `annotations:*`           | 字段 `cfiRange` → `locatorRange`                                       |
| `BookSummaryDto`          | 补 `format`（renderer 分发渲染器用）、`hasTextLayer`（门控用）         |
| `ChapterRefDto`           | 补 `startPage`/`endPage`（PDF 专用，nullable；TOC 跳页与当前章高亮用） |

## 6. 渲染层

`ReaderView` 按 `book.format` 分发 → 新 `PdfReader.tsx` + `pdf-book.ts` 适配层：

- **虚拟化**：不复用 VirtualDocs（iframe-HTML 专用），新增依赖 **react-virtuoso** 虚拟化页列表（主 app 此前未用它；ui-prototype 有使用经验与坑记录）。每页 = `canvas`（pdfjs render）+ textLayer div 叠加。`getViewport` 给出精确页高 → 高度天生稳定（无需 ePub 那套测高缓存）。
- **worker**：pdfjs-dist 标准 build + vite worker 入口（`GlobalWorkerOptions`）。
- **缩放**：适宽默认（容器宽度驱动 viewport scale）+ 顶栏缩放档位；档位切换触发可视页重渲。
- **选区 → AI**：textLayer 原生 DOM selection（无 iframe 桥，同文档直接 `getSelection()`）→ 映射页内字符偏移 + 选中文本。textLayer 的 span 流就是按 `getTextContent` items 构建的，与 §4 存储偏移天然同一坐标空间。`SelectionInfo` 形状不变（AI 契约零改动）；PDF 无段落 DOM，`paragraphBefore/Current/After` 用选区前后 N 字符窗口替代。
- **高亮绘制**：locatorRange 偏移 → textLayer Range → `getClientRects()` → 半透明矩形 overlay 层（PDF 阅读器标准做法）。**不往 textLayer 包 `<mark>`**——span 带绝对定位 transform，插节点破坏排版。点击 overlay 矩形 = 编辑入口（对齐 ePub 点击高亮编辑）。
- **进度**：顶部可见页 + 页内 scrollRatio → `pdf:` locator；恢复时滚回。
- **暗色模式**：canvas 容器 CSS `filter: invert(1) hue-rotate(180deg)`，跟随 app 颜色模式 + 按书可关（图片负片，已知局限）。
- **偏好门控**：字体/行高/字号设置对 PDF 无意义 → ReaderPrefs UI 按格式隐藏该组。
- **内存**：virtuoso 卸载离屏 DOM + `page.cleanup()` 释放 pdfjs 页资源（对称 ePub `unloadSection` 策略）。

## 7. AI 工具按格式分发

```
buildTools(book):
  epub → getToc / readChapterText / getChapterSummary（现状不变）
  pdf  → getToc / readChapterText / getChapterSummary
         + readPage(page, mode: "text" | "image")
```

- **`readPage(page, "text")`**：该页文本表示。v1 实现 = 文本层提取（`getTextContent`）；扫描版该形式返回明确错误，引导模型改用 image 形式。**实现期开放决策**：后续可在同一接口下接真 OCR（macOS Vision / tesseract）使扫描版也出文本——接口语义稳定，实现可替换。
- **`readPage(page, "image")`**：`renderPageImage` 渲染 PNG → tool result 图像内容。视觉模型直接「看」排版/图表/公式。
- **provider 能力门控**：tool result 带图像是 provider 差异区（Anthropic 原生支持；OpenAI Chat Completions 的 tool 消息只收纯文本）。image 形式按「模型支持视觉 + provider 支持图像 tool result」决定是否在工具 schema 中声明；不支持时只声明 text 形式，避免模型调用后失败。能力判定的具体机制（已知映射表 / provider 配置）在实现计划阶段定。
- 摘要链路（章节/全书）继续走 `readChapterText` 纯文本喂入，不走 image（整本喂图 token 爆炸）。
- **system prompt 注入**：PDF 会话的系统提示附加一行「本书为 PDF，共 N 页；可用 readPage 按页读取，image 形式可查看图表/排版」——否则模型未必意识到页粒度工具的存在价值。
- **既有工具兼容性（已审查）**：`getToc`/`getChapterSummary`/`readChapterText` 的描述与输入输出形状均格式中立（无 spine/CFI 等 ePub 专属概念外漏），PDF 下无需分叉版本；`resolveChapterRef` 的 id/href 双解析对 PDF 合成 href（`pdf-ch:<i>`）同样成立。

## 8. 扫描版（`hasTextLayer=false`）门控矩阵

| 功能            | 状态 | 机制                                                                         |
| --------------- | ---- | ---------------------------------------------------------------------------- |
| canvas 渲染阅读 | ✅   | 免费（本来就是画位图）                                                       |
| 进度保存/恢复   | ✅   | 页 + scrollRatio，不依赖文本                                                 |
| TOC 跳页        | ✅   | outline 若存在仍可用（扫描版也可能带书签）                                   |
| 聊天问答        | ✅\* | 视觉模型经 `readPage(image)`；非视觉模型工具不可用，按 §7 门控               |
| 选区问 AI       | ❌   | textLayer 为空 → 选区天然无从发生，无需特判                                  |
| 高亮标注        | ❌   | 同上                                                                         |
| 章节/全书摘要   | ❌   | UI 入口禁用 + tooltip 说明；主进程同时加防御（明确报错，绝不静默生成空摘要） |

门控双层结构：UI 层管体验（提前告知原因），主进程层管正确性（任何路径都不可能对扫描版静默产出空结果）——业务不变量不靠 UI 守。

## 9. 分阶段交付

| 阶段       | 内容                                                                                                                                  | 验收                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **PDF-P1** | `pdf-parser` 包 + schema 迁移 + 导入分发（含封面）+ `PdfReader` canvas 渲染（虚拟化、适宽+档位、暗色滤镜）+ 进度 locator + 扫描版检测 | 导入真实 PDF 能读、恢复进度；扫描版能看；封面出现在书库；**ePub 全回归**      |
| **PDF-P2** | textLayer 选区 → SelectionInfo → 问 AI；outline 章节 TOC 跳页 + 章节/全书摘要接通；`readPage` 工具（text+image）+ 扫描版门控 UI       | 选一段技术文档问 AI 流式回复；视觉模型问答扫描版；无 outline 书退化单章可摘要 |
| **PDF-P3** | 标注：偏移 locatorRange 持久化 + 矩形 overlay 高亮 + 点击编辑 + 侧栏列表互通                                                          | 高亮跨重启稳定恢复；与 ePub 标注共用侧栏                                      |

## 10. 测试策略

- `pdf-parser` headless vitest：fixture 三枚（有 outline / 无 outline / 扫描版）；fixture 来源（`pdf-lib` 脚本生成 vs 提交小文件）在实现计划阶段定。
- 主进程：导入魔数分发、`readChapterText` 格式分发、扫描版摘要防御、`readPage` 工具——`:memory:` SQLite 既有模式。
- 迁移：RENAME COLUMN + 新列对既有 ePub 库的兼容（老库升级后 progress/annotations 原样可用）。
- 渲染层：CDP 真启动冒烟（导入 → 渲染 → 缩放 → 选区 → 问答 → 高亮 → 重启恢复进度）。
- 打包：`@napi-rs/canvas` 的 `.node` 需进产物并 unpack（对齐 better-sqlite3 的 auto-unpack-natives + ignore 白名单模式）；打包冒烟须含 PDF 导入。

## 11. 已知局限（v1 接受）

- 暗色模式下 PDF 内图片负片（CSS invert 滤镜的业界通病；可按书关闭暗色）。
- 多栏 PDF 文本提取顺序不保证（影响选区上下文与摘要质量；用户实际文档以单栏书籍/技术文档为主）。
- 标注偏移依赖 pdfjs 文本提取的跨版本稳定性；`selectedText` 快照作重锚定兜底，重锚定逻辑本身 v1 不实现。
- 无 outline 的 PDF 章节摘要 ≈ 全书摘要（单章退化）。
- Ctrl+滚轮平滑缩放、PDF 文档句柄缓存：backlog。

## 12. 被否方案（留档）

- **PDF 转 HTML 统一管线**：下游零分叉但视觉保真是硬伤——技术文档的表格/代码块/图文混排转 HTML 必乱，扫描版完全无法转。与「对齐 ePub 全功能的真 PDF 阅读」目标冲突。
- **Chromium 内置 PDF viewer（`<webview>`）**：近零成本"能看"，但黑盒——选区取不出、标注画不上、进度控不了，全功能诉求下不可行。
- **统一 `BookAdapter` 渲染抽象**：CFI 方法对 PDF 无意义、页渲染对 ePub 无意义，强行统一只得 null 实现堆；按 format 分发到两套各自内聚的 reader 更诚实。
