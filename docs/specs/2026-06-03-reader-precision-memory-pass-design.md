# 阅读精度 / 长书内存 pass · 设计文档

> 状态：设计已评审通过，待 `writing-plans` 出实现计划。
> 日期：2026-06-03
> 关联：RA1-full（epub.js 真实渲染）刻意推迟的「精度/内存」优化；ROADMAP backlog「虚拟滚动高度稳定性」「长书 section.document 常驻内存」「当前章高亮滞后」。

## 背景与目标

RA1-full 落地后留下三项被刻意推迟的阅读体验债，本设计一次收口：

- **① 滚动高度稳定**：消除向上滚动跳闪、图片加载后的高度突变。
- **② 长书内存有界**（spec 成功判据）：`section.document` 不再随阅读无限常驻。
- **③ 当前章高亮精度**：消除 Virtuoso `overscan` 造成的「当前章」偏移。

**成功判据**：① 向上滚动无可见跳闪；② 长书全程滚动后内存回落（已离开视口足够远的 section 文档被释放）；③ 当前章高亮跟手（对应真实视口顶 section）。

**验证方式**：把估高、unload 距离决策、视口顶 index 计算抽成**纯函数做 headless 单测**；渲染/手感（不跳、内存回落、当前章跟手）走**真书手测**。

## 现状与根因（探索结论）

- **VirtualDocs**（`packages/virtual-docs/src/VirtualDocs.tsx`）：react-virtuoso 封装，**未设 `defaultItemHeight`/`overscan`/`increaseViewportBy`**，纯 auto-measure；当前章经 `rangeChanged.startIndex` 上报（`VirtualDocs.tsx:92`），其注释（`:22-24`）自承「含 overscan，近似而非视口顶」。
- **SectionFrame**（`packages/virtual-docs/src/SectionFrame.tsx:133-142`）：iframe `onLoad` 后测 `doc.documentElement.scrollHeight` 设 `iframe.style.height`，并用 ResizeObserver 在内容**任何变化**时持续重测。
- **prefs-to-css**（`packages/virtual-docs/src/prefs-to-css.ts:25`）：`img { max-width:100%; height:auto }`，图片**无尺寸预留**。
- **epub-book**（`src/renderer/reader/epub-book.ts:66-75`）：`loadSection` 渲染后 **`section.document` 保留、刻意不 `unload`**（注释 `:72`），仅 `book.destroy()`（`:150-156`）释放；`cfiAtIndex`（`:105-116`）/`cfiFromRange`（`:128-138`）依赖 `s.document` 常驻，`rangeFromCfi`（`:140-148`）用调用方传入的 `doc`（iframe 自己的 document）。

**根因**：

1. **①**：图片无预留 + 无估高 → 图片加载后 `scrollHeight` 变 → ResizeObserver 触发 → Virtuoso remeasure；当变化发生在视口**上方**的 item 时，Virtuoso 修正 `scrollTop`，表现为「向上滚跳/闪」。
2. **②**：每个访问过的 `section.document` 累积在 epubjs spine，无 unload 路径，直到关书。
3. **③**：`startIndex` 含 overscan，比真实视口顶 section 偏上 1–2 个。

## 方案 A（已选）总览

所有核心改动落在 **store-agnostic** 的 `virtual-docs` / `epub-book`，与 #10（reader-store 重构）正交、与 #8（IPC）/封面（书库）无交集。

| 单元                                 | 职责                                    | 本次改动                                                                         |
| ------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------- |
| `virtual-docs/SectionFrame.tsx`      | iframe 自适应高度                       | **①** 改「就绪后一次性上报稳定高度」                                             |
| `virtual-docs/VirtualDocs.tsx`       | Virtuoso 封装                           | **②** 按距离阈值协调 unload；**③** IntersectionObserver 上报视口顶；维护测高缓存 |
| `virtual-docs/`（新纯逻辑模块）      | 视口顶计算 / unload 距离决策 / 估高占位 | headless 单测落点                                                                |
| `src/renderer/reader/epub-book.ts`   | section 生命周期                        | **②** 新增 `unloadSection(index)` = `section.unload()`                           |
| `src/renderer/reader/EpubReader.tsx` | 集成                                    | 消费 ③ 新回调、转发 ② unload（调用点 / store 结构**不变**）                      |

### 数据流

- **③** IO 测各渲染 section 的 rect → 纯函数 `topVisibleIndex` 算视口顶 → `onTopSectionChange(index)` → EpubReader → `setCurrentChapter`（调用点不变）。
- **②** VirtualDocs active range 变 → 纯函数 `sectionsToUnload` 算淘汰集 → `onUnloadSection(index)` → EpubReader 转发 → `epub-book.unloadSection`。
- **①** SectionFrame 图片/字体就绪 → 测稳定 `scrollHeight` → 设 iframe 高度并写测高缓存；就绪前用缓存值作占位。

## 详细设计

### ① 高度稳定

- `SectionFrame` 的 `onLoad` 改为：
  1. 先用**估高占位**（取测高缓存中该 index 的高度，无则默认估值）设 iframe 初始高度。
  2. 并行 `await Promise.all([...doc.images].map((img) => img.decode().catch(() => {})))` + `doc.fonts.ready`，整体带**超时兜底**（`READY_TIMEOUT_MS`，如 2000ms）。
  3. 就绪（或超时）后测 `scrollHeight` 设最终高度，并写入测高缓存。
- ResizeObserver 保留，但仅服务「**就绪后**的真实内容变化」（如用户改字号偏好），加 **debounce**（如 100ms），避免加载过程中的多次抖动。
- **测高缓存**：VirtualDocs 维护 `Map<index, number>`；prefs（影响排版的字号/行距等）变更时**整体失效**。
- 纯逻辑：`estimateHeight(index, cache, defaultEstimate)` → 占位高度。

### ② 长书内存

- `epub-book` 新增 `unloadSection(index): void`，内部 `section.unload()` 释放 `s.document`。
- VirtualDocs 跟踪 active range（Virtuoso 渲染区间），纯函数 `sectionsToUnload(activeRange, total, keepDistance)` 返回「距 active range 超过 `keepDistance`（默认 5，可调）」的 index 集，逐个经 `onUnloadSection(index)` 上报；EpubReader 转发到 `epub-book.unloadSection`。
- **重进视口**：`loadSection` 重新 `render`（已是 async + LazySection loading 占位）。
- **CFI 安全性**（关键不变量）：`cfiAtIndex`（存进度）/`cfiFromRange`（选区）只在**可见 section** 触发，`rangeFromCfi`（标注渲染）用 iframe 自身 doc；故 unload 远离视口的 section.document 不影响任何 CFI 操作。
- 纯逻辑：`sectionsToUnload(activeRange, total, keepDistance)` → `number[]`。

### ③ 当前章精度

- VirtualDocs 用 IntersectionObserver（`root` = Virtuoso 滚动容器）观察各渲染 section 容器；纯函数 `topVisibleIndex(rects, viewportTop)` 从各 section 的 `{ index, top, bottom }` 与视口顶选出真实视口顶 section → `onTopSectionChange(index)`。
- **fallback**：IO 不可用时退回 `rangeChanged.startIndex`（保持现有行为，不退化为错误）。
- EpubReader：以 `onTopSectionChange` 取代 `onTopIndexChange` 的当前章/进度计算；`setCurrentChapter` 与进度 CFI 的调用点、store 结构**均不变**（仅 index 更准）。
- 纯逻辑：`topVisibleIndex(rects, viewportTop)` → `index`。

## 决策记录

- **unload 触发 = VirtualDocs 距离阈值主动**：与 Virtuoso overscan 解耦、`keepDistance` 可控、可纯函数测。（备选「跟随 LazySection unmount」弃用：粒度受 overscan 牵制、难单测。）
- **估高占位 = 测高缓存 `index→height`**：会话内复用、unload 重进/回滚时减少二次跳；prefs 变失效。（备选「固定估值」弃用：首屏/重进估得粗。）

## 错误处理 / 边界

- 图片 `decode()` 失败或整体就绪超时 → 用当前 `scrollHeight` 兜底，**绝不无限等**。
- unload 后重进、`render` 失败 → 走 LazySection 既有错误态。
- prefs 变更 → 清空测高缓存（高度可能全变）。
- IO 不支持 → fallback `rangeChanged.startIndex`。
- `keepDistance` 之内一律不 unload，保证小幅滚动/回滚不抖、不触发重渲。

## 范围 / 非目标

- **不改 reader-store 结构**：③ 仅让上报的 index 更准，`setCurrentChapter` 调用点不变 → 与 #10 正交。
- **不碰 IPC**（#8）、**不碰书库/封面**。
- **不做方案 B**：持久化高度表、主进程预解析图片固有尺寸——YAGNI；若真书手测仍不够稳再单列。
- 当前章高亮在 store 里的存法本身留给 #10。

## 测试策略

- **headless 纯函数单测**：`topVisibleIndex`、`sectionsToUnload`、`estimateHeight`。
- **真书手测**：① 向上滚动不跳闪；② 长书全程滚动后内存回落（DevTools heap / 已 unload 的 section 计数）；③ 当前章高亮对应真实视口顶。
- 可选：`epub-book` `loadSection`/`unloadSection` 往返轻测（若 epubjs 能在 vitest/Electron 运行时跑）。

## 单元清单（供 writing-plans）

1. `virtual-docs/` 新纯逻辑模块 + 单测：`topVisibleIndex` / `sectionsToUnload` / `estimateHeight`。
2. `virtual-docs/SectionFrame.tsx`：①「就绪后上报稳定高度」+ 测高缓存写入 + ResizeObserver debounce。
3. `virtual-docs/VirtualDocs.tsx`：② 距离阈值 unload 协调 + `onUnloadSection`；③ IntersectionObserver + `onTopSectionChange`；测高缓存维护 + prefs 失效。
4. `src/renderer/reader/epub-book.ts`：② `unloadSection(index)`。
5. `src/renderer/reader/EpubReader.tsx`：消费 `onTopSectionChange`、转发 `onUnloadSection`。6.（按需）`virtual-docs/prefs-to-css.ts`：若 ① 需要图片占位 CSS 辅助。
