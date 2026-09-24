# RA3 标注与笔记 + M-b 持久化 设计

> 状态：已与用户逐段确认（2026-06-02）；交互按 Apple Books 修订（高亮/笔记分离、样式工具栏、笔记 modal）。终态指向 writing-plans。
>
> 关联：`2026-05-31-marginalia-core-reading-loop-design.md` §11.5（标注产品决策）、`2026-06-01-marginalia-up1-ui-prototype-design.md`（UI 原型）、记忆 `annotations-core-decision`；前置能力来自 RA1-full（`SelectionInfo.cfiRange`、`epub-book` 的 CFI 能力、`@marginalia/virtual-docs`）。

## 目标

把标注与笔记从 UP1 原型落成真实可用功能：在真实 ePub 正文上**多色高亮 / 下划线 + 段内便签**，持久化（重开书恢复），侧栏标注列表汇总 + 跳转。一个 spec，分阶段实现，逐阶段真书手测。

## 范围

- **M-b（主进程）**：`annotations` 表 + 迁移 + repository（纯函数）+ IPC（增删改查）+ preload 暴露。
- **RA3（渲染层）**：选区主工具栏加「高亮标记 / 添加笔记」入口、二级样式工具栏（5 色 + 下划线）、笔记 modal、正文 CFI 高亮渲染 + 点击编辑、侧栏「标注」列表 + 跳转。
- **接缝**：`epub-book` CFI API 加 `ignoreClass`；`@marginalia/virtual-docs` 加 3 个通用装饰钩子。

**不在范围（见 §10 刻意推迟）**：跨 section 高亮、CFI 失效模糊重定位、标注导出、便签富文本、会话页签。

## 1. 产品行为（承接 core §11.5 + UP1，交互仿 Apple Books）

- **高亮标记与添加笔记是分开的两个动作**。划词后**主工具栏**并列：`高亮标记` · `添加笔记` · AI（解释/翻译/概括）。
- **点「高亮标记」** → 弹二级**样式工具栏**：5 填充色（yellow/green/blue/pink/purple）+ 下划线，共 **6 个互斥样式**；点一个即落标注、关工具栏。
- **点「添加笔记」** → 弹 **modal**（textarea 写笔记）；保存即建一条带笔记的标注（默认样式 `yellow`，之后可在样式工具栏改）。有笔记的标注带 ✎ 标记。
- **编辑已有标注**：点击正文高亮 → 弹样式工具栏（换样式）+ `笔记`（→ 同一 modal 加/改笔记）+ `删除`。
- **列表**：侧栏「标注」页签汇总全书标注，按阅读顺序排序、按章分组，点击跳回正文。
- **与 AI 选区流并行**：标注是基础阅读功能，不依赖会话；主工具栏同时承载 高亮/笔记 + AI 动作（共存）。

## 2. 数据模型（M-b）

`src/main/db/schema.ts` 新增（对齐现有 uuidv7 PK + CHECK + 外键风格）：

```
annotations(
  id            text PK     = uuidv7()
  book_id       text NOT NULL → books.id
  style         text NOT NULL  CHECK in (yellow,green,blue,pink,purple,underline)
  note          text NOT NULL  DEFAULT ''      -- 段内便签（''=仅高亮无笔记）
  selected_text text NOT NULL                  -- 选中原文快照（列表展示 + CFI 失效兜底）
  cfi_range     text NOT NULL                  -- 单个 epubjs 区间 CFI 串（锚点）
  created_at    integer NOT NULL = Date.now()
  updated_at    integer NOT NULL = Date.now()
)
index on (book_id)
```

**关键决定：**

- **单 `style` 字段 6 值**（5 填充色 + `underline`）：「下划线」是与 5 色并列的第 6 个互斥样式，非颜色变体——故一个 `style` 列 + CHECK 即可，无需 color×style 矩阵。渲染时 5 色 → 背景填充，`underline` → `text-decoration`。
- **单 `cfi_range`**（非 §11.5 的 `{cfiStart,cfiEnd}`）：epubjs `cfiFromRange` 本就产出**一个区间 CFI 串**（`epubcfi(base,start,end)` 形式），`EpubCFI.toRange` 也吃这单串；RA1-full 的 `SelectionInfo.cfiRange` 已经在存它，直接复用、零换算。
- **不存 `chapter_id`、不存 `ranges[]`**：侧栏列表的「所属章 + 阅读序」全部**展示时从 `cfi_range` 派生**（`indexOfCfi`→spinePos→`hrefAtIndex`→`chapterIdByHref` 得章；`EpubCFI.compare` 排序）。单一真相源、永不与正文不一致；阅读器里书已解析，派生廉价。UP1 的跨段 `AnnoRange[]` 在「单 section 选区」机制下用不上（见 §5）。

迁移用 `pnpm db:generate` 生成（drizzle-kit 新格式子目录），勿手编。

## 3. IPC + repository（M-b）

**Zod + 类型**（`src/shared/annotations.ts` 新增；`z.infer` 推导 DTO，对齐 `src/shared/chat.ts` 风格）：

- `AnnotationStyle = "yellow"|"green"|"blue"|"pink"|"purple"|"underline"`
- `AnnotationDto = { id, bookId, style, note, selectedText, cfiRange, createdAt, updatedAt }`
- `CreateAnnotationInput = { bookId, style, note, selectedText, cfiRange }`
- `UpdateAnnotationInput = { id, patch: { style?, note? } }`

**IPC 通道**（`src/shared/ipc.ts` 加常量；`src/main/ipc/annotations-handlers.ts` 注册，对齐 `chat-handlers.ts` 的 `handle(channel, schema, fn)` + `getDb()` 注入模式）：

- `annotations:list-by-book` `{bookId}` → `AnnotationDto[]`（按 `created_at` 取，排序在渲染层按阅读序做）
- `annotations:create` `CreateAnnotationInput` → `AnnotationDto`
- `annotations:update` `UpdateAnnotationInput` → `AnnotationDto`
- `annotations:delete` `{id}` → `void`

**Repository**（`src/main/library/annotations.ts` 纯函数注入 `DB`，不碰 Electron，headless 可测）：`listAnnotationsByBook` / `createAnnotation` / `updateAnnotation` / `deleteAnnotation`；缺书时 create 抛可读错误。

**Preload**：`src/preload.ts` 加 `window.api.annotations.{listByBook,create,update,delete}`。

## 4. 锚定 + 高亮渲染/点击（RA3 核心）

**捕获（已就绪）**：RA1-full 的 `onSelect` 已 `cfiFromRange(index, range)` 写入 `SelectionInfo.cfiRange`；建标注直接拿它存库。

**渲染管线**（section iframe 加载后 / 标注变化后执行，方案 A：内联 `<mark>` + `ignoreClass`）：

1. 对该 section 的每条标注：`new EpubCFI(cfiRange).toRange(iframeDoc, "anno")` 得 iframe 内 DOM Range。
2. 把 Range 内文本节点逐个包成 `<mark class="anno anno-{style}" data-anno-id="…">`（Range 跨多节点时按文本节点切分逐段包——`surroundContents` 对部分节点会抛，故遍历文本节点）。5 色样式 → 背景填充；`underline` → `text-decoration: underline`；有笔记附 ✎。
3. **best-effort**：`toRange` 抛错/返空（CFI 失效）→ 跳过该条不渲染，它仍留在侧栏列表（用库里 `selectedText`/`note` 快照）。不做模糊重定位。

**`@marginalia/virtual-docs` 扩展（保持对 epub 无知）**——两个通用钩子 + 一个 handle 方法：

- `decorate?(index, doc): void`：section iframe 内容加载后（及改偏好 iframe 重载后）由包回调；**app 在此做 toRange→包 mark**（CFI/epubjs 逻辑全留 app 侧）。`decorate` 幂等：先清 doc 内旧 `.anno` 再重贴。
- `onHighlightClick?(annoId, rect): void`：**包自身**在 iframe 上侦听 `[data-anno-id]` 点击（包持有 iframe + `toViewportRect`），算好视口坐标回调。包只认「带 `data-anno-id` 的装饰元素 + 其点击」通用契约。
- `VirtualDocsHandle.redecorate()`：标注增删改后 app 调它 → 包对所有在挂 section 重跑 `decorate`。

**CFI 完整性（关键）**：插入的 `<mark class="anno">` 改变 DOM 结构，故 `epub-book.ts` 算 CFI 时统一传 `ignoreClass:"anno"`（`cfiFromRange` / `cfiAtIndex` / `toRange` 都带），让 epubjs 视高亮 mark 为透明、CFI 路径不受污染——新选区、进度锚点、已存标注互不干扰。各 API 的 `ignoreClass` 入参签名在 writing-plans 阶段按真实 `.d.ts` 核定（若 `section.cfiFromRange` 不收该参，改用 `new EpubCFI(range, section.cfiBase, "anno")`）。

**数据流**：

- **建高亮**：划词 → 主工具栏点「高亮标记」→ 样式工具栏点某样式 → `api.annotations.create({bookId, style, note:'', selectedText, cfiRange})`。
- **建笔记**：划词 → 主工具栏点「添加笔记」→ modal 写笔记保存 → `create({bookId, style:'yellow'（默认）, note, selectedText, cfiRange})`。
- **改/删**：点已有高亮 → 样式工具栏换样式 `update({patch:{style}})` / 笔记入口开 modal `update({patch:{note}})` / 删除 `delete({id})`。
- 三者成功后均 invalidate `qk.annotations(bookId)` + `vRef.redecorate()`，正文与列表天然同步；建标注后清选区。

## 5. 渲染层 UI（RA3）

- **SelectionToolbar（主工具栏）扩展**：在现有「解释/翻译/概括」AI 按钮旁加 `高亮标记`、`添加笔记` 两个入口（不再内联色块）。`高亮标记` → 开样式工具栏（针对当前选区）；`添加笔记` → 开笔记 modal（针对当前选区）。
- **HighlightStyleBar（二级样式工具栏，新组件）**：5 色 swatch + 下划线（6 互斥）。两种来源：① 选区的「高亮标记」（点样式 → create + 关 + 清选区）；② 点已有高亮（target 为该标注：点样式 → `update({patch:{style}})`；并额外显示 `笔记`（→开 modal 编辑该标注笔记）+ `删除`（→ `delete`））。定位用 rect（选区 rect 或高亮 rect）；点外部/滚动即关。
- **NoteModal（笔记 modal，新组件）**：居中浮层 + textarea + 保存/取消。两种来源：① 选区的「添加笔记」（保存 → create 带 note + 默认 style）；② 编辑已有标注笔记（保存 → `update({patch:{note}})`）。
- **Sidebar 加「标注」页签**：左栏顶部加 **目录 | 标注** 切换（UP1 的「会话」页签归 RA4，本轮不上）。标注页：全书列表，按阅读序排序（spinePos + `EpubCFI.compare`）、按章分组（派生章名）；每条 = 样式色条 + 原文摘录 + 笔记预览 + 章名；点击 → `scrollToIndex(spinePos)` + best-effort 把高亮 mark 滚入视口。
- **store / query 接线**：annotations **走 TanStack Query**（`qk.annotations(bookId)` = listByBook）作单一真相源（decorate 渲染、侧栏列表、工具栏/modal 取数都读它；增删改后 invalidate + `redecorate()`）。`reader-store` 仅加 UI 态：
  - `styleBar: { rect, target: {type:'create'} | {type:'edit', annotationId} } | null`
  - `noteModal: { target: {type:'create'} | {type:'edit', annotationId} } | null`（create 用 `store.selection` 快照）
  - 标注数据本身不进 store，避免双源。

## 6. 错误处理 / 边界

- **CFI 失效**：`toRange` 抛错/返空 → 该高亮不渲染于正文，但条目仍在侧栏列表（快照展示）；不丢笔记。v1 不做模糊重定位（§10）。
- **`chapterIdByHref` 返 null**（封面/版权页等不在 TOC 的 section）：列表归入「未分组/其他」，仍可点击跳转。
- **缺书/非法 style**：repository 层抛可读错误 / DB CHECK 拒绝。
- **同一本书字节稳定**（`readEpubBytes` 读存盘文件）→ CFI 跨会话稳定，正常路径不触发失效。

## 7. 测试策略（两轨）

- **headless vitest**：M-b repository（建/列/改/删、缺书抛错、CHECK 拒非法 style）、IPC 入参校验、抽出的纯函数（阅读序排序 / 派生章名）。
- **typecheck**：`epub-book` ignoreClass 改动、包钩子类型。
- **真书手测检查点**：6 样式（5 色 + 下划线）建高亮 + 正文渲染、点高亮→样式工具栏（换样式/笔记/删）、添加笔记 modal、✎ 标记、侧栏列表（排序/分组/跳转）、**持久化**（重开书→标注恢复）、**CFI 完整性**（建标注后再选别处 CFI 仍对、进度不乱）、best-effort（CFI 失效→仅列表）。

## 8. 分阶段实现顺序（writing-plans 细化为 bite-sized）

风险递增、先夯可 headless 测的后端，再逐层接真书手测，每阶段一 commit：

1. **M-b**：schema + 迁移 + repository（headless 测）+ IPC + preload。
2. **epub-book**：CFI 各 API 加 `ignoreClass:"anno"`（typecheck）。
3. **virtual-docs 包**：加 `decorate` / `onHighlightClick` / `redecorate` 三钩子。
4. **渲染集成**：EpubReader 接 `qk.annotations` query + decorate（CFI→mark）+ 点击接线。〔手测：渲染 + 点击〕
5. **主工具栏 + 样式工具栏**：主工具栏加 高亮/笔记 入口；样式工具栏（5 色 + 下划线）建标注。〔手测〕
6. **笔记 modal + 编辑**：笔记 modal（建/改）+ 点已有高亮 → 样式工具栏（换样式/笔记入口/删除）。〔手测〕
7. **侧栏**：目录/标注双页签 + 列表 + 跳转。〔手测〕

## 9. 涉及文件（地图）

| 文件                                                       | 改动                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `src/main/db/schema.ts`                                    | 加 `annotations` 表                                   |
| `src/main/db/migrations/<new>/`                            | `pnpm db:generate` 生成                               |
| `src/main/library/annotations.ts` (+`.test.ts`)            | repository 纯函数 + headless 测                       |
| `src/shared/annotations.ts`                                | Zod + DTO（`AnnotationStyle` 6 值）                   |
| `src/shared/ipc.ts`                                        | 加 `annotations:*` 通道常量                           |
| `src/main/ipc/annotations-handlers.ts`                     | 注册 handler                                          |
| `src/preload.ts`                                           | 暴露 `window.api.annotations.*`                       |
| `src/renderer/reader/epub-book.ts`                         | CFI API 加 `ignoreClass`；可加 `rangeFromCfi` 辅助    |
| `packages/virtual-docs/src/{VirtualDocs,SectionFrame}.tsx` | `decorate`/`onHighlightClick`/`redecorate`            |
| `src/renderer/reader/EpubReader.tsx`                       | 接 annotations query + decorate + 点击 → 样式工具栏   |
| `src/renderer/reader/SelectionToolbar.tsx`                 | 加 高亮标记 / 添加笔记 入口                           |
| `src/renderer/reader/HighlightStyleBar.tsx`                | 新组件（5 色 + 下划线；create/restyle/笔记入口/删除） |
| `src/renderer/reader/NoteModal.tsx`                        | 新组件（笔记 modal，建/改）                           |
| `src/renderer/reader/AnnotationsList.tsx` + 侧栏页签       | 新组件 + 目录/标注切换                                |
| `src/renderer/store/reader-store.ts`                       | 加 `styleBar` / `noteModal` UI 态                     |
| `src/renderer/query/keys.ts`                               | 加 `qk.annotations(bookId)`                           |

## 10. 刻意推迟（YAGNI / 后续）

- **跨 section 高亮**：当前包 `onSelect` 在单 iframe 内捕获选区，跨 section 选区不可建；保持「一标注 = 一 section 内一 cfiRange」。
- **CFI 失效模糊重定位**：v1 仅 best-effort 渲染 + 列表快照展示；用 `selectedText` 搜索重定位留后续。
- **「位置失效」显式标记**：判定需逐条试 `toRange`（要 section 已渲染），v1 不做列表标记。
- **下划线的颜色变体**（如「绿色下划线」）：v1 下划线为单一中性样式；color×style 矩阵留后续。
- **笔记 modal 内选色**：v1 笔记默认 `yellow`、之后样式工具栏改；modal 内直接选色留后续。
- 标注导出 / 便签富文本 / 高亮跳回时的强调动画 / 会话页签（RA4）。
