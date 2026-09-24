# EPUB 可读文本量进度设计

日期：2026-07-15  
状态：已确认  
关联需求：GitHub Issue #105

## 背景

Marginalia 当前用下面的近似式计算 EPUB 阅读进度：

```text
(当前 spine 索引 + 当前 section 内像素滚动比例) / spine 总数
```

这个算法把每个 spine 文档视为等量内容。现实 EPUB 的 spine 粒度并不代表内容体量：封面、版权页和扉页可能各占一个很短的文档，整部正文却可能只压在一两个巨大的文档中。

用户报告的《钢铁是怎样炼成的》提供了稳定复现：它有 11 个 spine 项，前 6 项是很短的前置页，第 7、8 项承载约 98% 的全书文本，后 3 项又是很短的附录页。当前算法因此在第一部正文开头显示 `6 / 11 = 54.55%`，第二部开头显示 `7 / 11 = 63.64%`，正文读完时仍只有 `8 / 11 = 72.73%`。按可读文本量估算，这三个位置应分别约为 1%、40% 和 99%。

问题不是该 EPUB 损坏，而是 reader 把物理打包边界误当成了阅读体量。

## 目标

- EPUB 百分比表示已经越过的可读文本量，而不是 spine 数量或渲染像素距离。
- 同一个文本位置对应稳定的百分比；调整字号、行距、阅读宽度或窗口大小不能直接改变该位置的百分比。
- 顶栏百分比、继续阅读书架和 `progress.percent` 继续消费同一个计算结果。
- 现有 CFI 定位、精确恢复、标注、章节追踪和 PDF 进度保持不变。
- 纯图片或无可读文本的 EPUB 仍能显示可用进度。
- 预计算失败不能阻止书籍打开。

## 非目标

- 不把 EPUB 改造成分页阅读模式。
- 不按纸书页码、Adobe page-map 或 EPUB `page-list` 计算进度。
- 不给图片估算“等价字符数”；本功能的产品语义明确是可读文本量。
- 不迁移或批量重写既有 `progress.percent` 数据。
- 不增加数据库列、IPC 契约或 parser version。
- 不改变 PDF 的 `page / pageCount` 算法。
- 不在本轮加入单词数、剩余时间或 location 编号等新 UI。

## 产品语义

### 可读文本量

一个 spine section 的权重是其 `<body>` 下可读文本节点的 UTF-16 code unit 数量。字符计数单位与 JavaScript 字符串的 `.length`、现有 `readChapterText` offset 相同；本功能使用原始 DOM 文本坐标，不复用 `readChapterText` 经过块筛选与空白规整后的字符串。遍历时：

- 纯空白文本节点不计数；
- `script`、`style`、`template` 及显式 `hidden` / `aria-hidden="true"` 子树不计数；
- 普通行内标签、块级标签和标注产生的包装标签不改变其后代文字权重；
- 不折算图片、SVG、音视频或 CSS 布局高度；
- 不依赖 TOC 条目数量，始终以物理 spine 阅读顺序累计。

保留文本节点内部的空白长度，可以让预扫描长度和 DOM Range 的原始 offset 使用同一坐标系。只要节点不是纯空白，其完整 `node.length` 都进入权重。

### 当前文本位置

`EpubReader` 已经为精确恢复寻找视口顶部的可读块，并在其首个文本节点建立 Range/CFI。本设计让同一次定位同时产出：

```ts
{
  cfi: string;
  textOffset: number | null;
}
```

`textOffset` 是当前 Range 起点之前、当前 section 内累计的可读文本量。它通过与预扫描完全相同的 DOM 遍历规则计算，而不是从 section 像素高度反推。

当前 locator 的精度仍是“视口顶部可读块的首字符”。百分比因此按块更新；顶栏只显示整数百分比，这个粒度足够稳定且与现有精确恢复语义一致。本轮不引入 `caretPositionFromPoint` 等子段落命中机制。

### 百分比公式

设 `lengths[i]` 为第 `i` 个 spine section 的可读文本量，`offset` 为当前 section 的文本偏移：

```text
total   = sum(lengths)
before  = sum(lengths[0 .. index-1])
percent = (before + clamp(offset, 0, lengths[index])) / total
```

结果继续 clamp 到 `[0, 1]`。显示层沿用 `Math.round(percent * 100)`。

## 架构与数据流

### 1. DOM 文本位置工具

新增 renderer 纯工具模块 `src/renderer/reader/epub-text-position.ts`，职责只有两项：

- `readableTextLength(doc)`：计算一个 section 文档的总可读文本量；
- `readableTextOffsetAtRange(doc, range)`：计算 Range 起点之前的可读文本量，无法映射时返回 `null`。

两个函数共享同一套节点过滤规则。Range 起点不属于目标文档、不是可读文本节点或位于被排除的子树时，offset 函数返回 `null`。模块不引用 React、zustand、Electron、epub.js Book 或数据库，使用 `happy-dom` 单测。

### 2. 开书时预扫描 spine

`createEpubBook(bytes)` 在 `book.opened` 后、向 `EpubSessionProvider` 暴露 `EpubBook` 前，按物理 spine 顺序逐个执行：

1. `section.load(book.load.bind(book))`，只加载该 XHTML 文档；
2. 对其 `ownerDocument` 调用 `readableTextLength`；
3. 把结果写入固定长度的 `textLengths` 数组；
4. 在 `finally` 中调用 `section.unload()`，再处理下一个 section。

扫描顺序执行，一次只保留一个 section 文档；不调用 `render()`，不替换或解码图片，也不保留全书 DOM。它不会使用 epub.js `locations.generate()` 的逐 section 延时队列，也不生成一份额外 CFI location 表。

扫描在 `EpubBook` 就绪前完成，因此 header 不会先显示旧的 spine 百分比、稍后再跳到文本百分比。`EpubBook` 新增只读快照 `textLengths: readonly number[]` 给百分比函数消费，`textLengthAtIndex(index)` 改为读取同一数组；`VirtualDocs.sectionWeight` 从首次挂载起也能得到所有 section 的真实文本权重，顺带改善未测量 section 的高度估算。数组长度必须等于 `book.count`，扫描失败的索引显式填 0，不能因稀疏数组改变 spine 对齐。

### 3. 滚动位置投影

`EpubReader.onTopSectionChange` 保留当前的视口顶部块选择与 CFI 生成，但把它收敛成一次位置投影：

1. 找到视口顶部的可读块和首个未被过滤规则排除的文本节点；
2. 建立 Range，并生成进度 locator CFI；
3. 用同一个 Range 计算 `textOffset`；
4. 调用纯函数计算全书百分比；
5. 把同一结果写入 `navigation-store.readingPercent` 并随 locator 防抖保存。

当前章跟随、AI 阅读上下文 offset、TTS 和标注逻辑不改变。AI 的 chapter-relative offset 继续使用现有章节语义，不复用全书进度 offset。

### 4. 纯百分比函数

`src/renderer/reader/percent.ts` 的 EPUB 分支改为接收：

- 当前 spine index；
- `textOffset: number | null`；
- 全部 `textLengths`；
- 仅供降级使用的当前 `scrollRatio`。

纯函数负责前缀累计、边界 clamp 与降级选择。PDF 函数保持原样。

## 降级与错误处理

### 单个 section 无文本

图片页、封面或空白页的 `lengths[i]` 为 0。在这些 section 中滚动时百分比保持不变；进入下一个有文本的 section 后从同一累计值继续。这符合“已读文本量”的产品语义。

### 单个 section 扫描失败

扫描某个 section 失败时：

- 用 renderer `epub` logger 记录一条 `warn`，包含 index/href，并把原始错误作为第二参数；
- 该 section 权重记为 0；
- 继续扫描后续 section，不阻止开书；
- 后续 VirtualDocs 正常加载该 section 时仍按既有错误路径处理，预扫描失败不预判正文一定无法显示。

### 整本书总文本量为 0

如果所有 section 权重之和为 0，`epubPercent` 退回现有 `(index + scrollRatio) / sectionCount`。这保证漫画、扫描型或纯图片 EPUB 仍有连续进度。

### 当前 Range 无法映射

如果当前 section 有文本，但 `readableTextOffsetAtRange` 返回 `null`，只对这一次计算使用 `clamp(scrollRatio) * lengths[index]` 作为 section 内偏移，并记录至多一次 `warn`，避免滚动日志风暴。全书 section 权重仍按文本量累计，因此不会退回“每个 spine 等权”的主要错误。

### 存量进度

现有 `progress.locator` 是恢复位置的真相源，不受影响。数据库中的旧 `percent` 只是展示快照，不做批量迁移：用户下一次打开并滚动该书时，reader 会按新算法保存同一 locator 对应的新百分比；返回书库后继续阅读卡片自然刷新。

## 性能与生命周期

- 预扫描发生在已有“载入中”阶段，结束前不挂 `VirtualDocs`，因此不会出现百分比重算跳变。
- 扫描只加载 spine XHTML，不渲染 section、不解码图片；成本与文本 section 数和文本量相关，而不是 EPUB 图片总大小。
- section 严格逐个 `load → count → unload`，避免把全书 DOM 留在内存。
- 切书或组件卸载时继续由现有 `alive` 守卫销毁创建中的/已创建的 epub.js Book；预扫描失败不得留下未释放 section。
- 本轮不落库缓存文本权重。只有实际测量显示重复开书成本不可接受时，才考虑派生数据缓存；不要预先引入 schema 和失效版本管理。

## 测试

### 纯函数

`percent.test.ts` 覆盖：

- 极不均匀的 section 权重；第一段正文不再按 spine index 跳到 50% 以上；
- 当前 section 内文本偏移插值；
- 0 长度 section 不推进进度；
- 全书 0 文本时退回 spine 算法；
- 负 offset、超长 offset、越界 index 和空数组的 clamp/防御行为；
- PDF 百分比不回归。

### DOM 文本坐标

`epub-text-position.test.ts` 使用 `happy-dom` 覆盖：

- 普通标题、段落、列表和嵌套行内标签的长度与 offset；
- 纯空白节点不计数；
- `script`、`style`、`template`、hidden 和 aria-hidden 子树不计数；
- `<mark class="anno">` 包装文字前后，长度和目标 offset 不变；
- 只改变 CSS、字号或容器宽度时，同一 Range 的 offset 不变；
- Range 不属于目标文档或起点不可识别时返回 `null`。

### EPUB 集成

用仓库内 fixture 构造“多个短前置 section + 两个巨大正文 section + 短后置 section”的 EPUB，覆盖：

- `createEpubBook` 在返回前得到完整 `textLengths`；
- 扫描后 section 已 unload，正常 `loadSection` 仍可再次渲染；
- 单个缺失/失败 section 不阻塞其余 profile；
- 全书 profile 顺序与 epub.js spine index 一致。

### 验证

- `pnpm test src/renderer/reader/percent.test.ts`
- 新增 DOM/EPUB profile 单测；
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- 用用户报告的《钢铁是怎样炼成的》冒烟：第一部开始约 1%，第二部开始约 40%，正文结束约 99%；在同一 CFI 改字号、行距和窗口宽度，整数百分比保持不变。

## 兼容性与交付边界

- 不改共享 IPC、preload、数据库 schema 或迁移。
- 不改 `progress.percent` 的 `[0,1]` 契约。
- 不改变 CFI 字符串格式，已有定位和标注继续可用。
- 不改变 PDF 进度。
- 用户可感知变更需要 changeset，英文 changelog 应说明 EPUB progress now reflects readable content rather than packaging boundaries。

## 已否决方案

### epub.js `locations.generate()`

它能生成固定字符间隔的 CFI location 表，但默认逐 section 延时处理；spine 很碎的书首次生成可能明显变慢。为了避免每次开书重算还需要序列化缓存、失效策略和额外持久化。当前 reader 已经拥有顶部 Range/CFI，无需再引入第二套位置索引。

### 导入时持久化 section 权重

这能减少重复开书扫描，但需要数据库迁移、存量书惰性重建、IPC 投影和 parser version 失效管理；当前 section 内 offset 仍必须在 renderer 计算。复杂度远高于收益，除非实测证明开书扫描成本不可接受。

### 仅按 section 字数加权、内部继续用像素比例

它能修复示例书的主要偏差，但 section 内进度仍会随图片高度、字号、行距和窗口宽度改变，违反已经确认的产品语义，因此不采用。
