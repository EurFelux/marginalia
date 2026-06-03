# 类 macOS 自绘滚动条 + 阅读区无条设计

> **日期**：2026-06-03
> **分支**：`feat/custom-scrollbar`（基于含右键删书的 main）
> **状态**：设计定稿，待 plan
> **关联 backlog**：用户 2026-06-03 指定两条——「移除阅读区原生滚动条」+「类 macOS 自绘滚动条（迁移 ui-prototype 的 `ScrollArea.tsx`，统一用于阅读区/侧栏等滚动容器）」

## 背景

渲染层多处用裸 `<div className="…overflow-y-auto">` 滚动，显示的是 OS 原生滚动条，与 Apple Books 风外壳不搭。ui-prototype 有一个零依赖自绘条原型 `ScrollArea.tsx`（隐原生 + 叠绝对定位 thumb + 滚动/悬停淡入、停手 900ms 淡出，`pointer-events-none` 纯指示、**不可拖**）。

项目已整体迁到 **shadcn（Base UI 基底，`style: base-nova`）**，`components/ui/*` 下已有一批手写包装 `@base-ui/react` primitive 的组件（`popover.tsx`/`dialog.tsx`/`context-menu.tsx` 等）。Base UI 自带 `ScrollArea` 原语（`@base-ui/react/scroll-area`），**Thumb 原生可拖、`data-hovering`/`data-scrolling` 驱动淡入淡出、a11y/键盘全内置**。

阅读区是 `react-virtuoso`（在 `@marginalia/virtual-docs` 包），**虚拟化下 `scrollHeight` 是随实测跳变的估算值**——自绘 thumb 套上去会乱跳（咬合 backlog「虚拟滚动高度抖动」精度债）。

## 设计决策（已与用户确认）

- **DD-1 阅读区：彻底无条**。阅读区（Virtuoso）只隐藏原生 OS 条、**不要任何 thumb**（不论自绘还是原生）。干净沉浸的书页，同时绕开虚拟化 thumb 难题（该难题留给将来的「精度/内存 pass」）。仅竖向（阅读不横滚）。
- **DD-2 其余容器：Base UI ScrollArea 原语**，而非迁移自搓原型。理由：项目刚标准化到 Base UI，可拖拽行为/键盘/a11y 白送，长期维护面更小，与「迁原语」backlog 方向一致。（放弃迁移 ui-prototype `ScrollArea.tsx`——其 thumb 不可拖，且自搓拖拽/a11y 需自维护。）
- **DD-3 交互：可拖拽 thumb，轨道不可点**。thumb 可鼠标抓拽滚动（Base UI 原生，拖拽期自动防选中）；点击空轨道翻页**不做**（overlay 窄条命中面积小、与内容点击区分需额外处理，超范围）。
- **DD-4 审美：macOS 细 overlay**。沿用原型语汇——thumb `w-1.5 rounded-full bg-foreground/35`，浮在右缘**不占布局**（不给 Content 留 gutter）。**仅滚动时显示**：`data-scrolling` 时 `opacity-100` 瞬现，停手后经 `duration-300` 渐隐；**不认 `data-hovering`**（悬停整区不显——经实机评审，整区 hover 持续显示太急、不符 macOS「show on scroll」预期）。
- **DD-5 实现结构**：新增 `components/ui/scroll-area.tsx` shadcn 风包装（手写包装 `@base-ui/react/scroll-area`，仿 `popover.tsx`——`cn` + 现有 token + `data-slot`）。**不跑 shadcn CLI**（primitive 已随 `@base-ui/react` 安装，无新依赖）。
- **DD-6 消费方范围**：7 处应用外壳容器换 ScrollArea；`Composer.tsx`（原生 `<textarea>` 内部滚动）与 `select.tsx`（Base UI Select 自管弹层）**排除**，保持现状。

## 架构 / 数据流

```
[阅读区] EpubReader ──► VirtualDocs(className="scrollbar-hide") ──► <Virtuoso className=…/>
            │                                                    （className 转发到 scroller 根 → @utility 隐原生条）
            └─► 无 thumb、无原生条

[外壳容器] 消费方 ──► <ScrollArea className=尺寸 [viewportRef]>
                          └─ Root(relative) ─ Viewport(size-full, 转发 ref) ─ Content{children}
                                            └─ Scrollbar(vertical, opacity 由 data-hovering/scrolling 切) ─ Thumb(可拖)
```

## §1 · `components/ui/scroll-area.tsx`（新）

包装 `@base-ui/react/scroll-area`（命名空间 `ScrollArea.{Root,Viewport,Content,Scrollbar,Thumb,Corner}`），仿 `popover.tsx`：`cn` + 现有 token + `data-slot`。导出 `ScrollArea` + `ScrollBar`。

- **`ScrollArea`**：渲染 `Root > Viewport > Content{children}` ＋ `<ScrollBar />` ＋ `Corner`。
  - props：`className`（→ Root，承尺寸/`relative`）、`viewportClassName`（→ Viewport，默认 `size-full`）、`viewportRef?: Ref<HTMLDivElement>`（透传到 Viewport，供程序化滚动如 AIPanel 滚底）、`children`（进 `Content`）、其余 `...props` → Root。
  - **`Content` 不可省**：Base UI 靠 Viewport vs Content 尺寸差测溢出（`data-has-overflow-y`），省了则不溢出时 scrollbar 不显/显错。
- **`ScrollBar`**：`Scrollbar(orientation="vertical") > Thumb`。
  - Scrollbar：`flex w-2.5 touch-none select-none justify-center opacity-0 transition-opacity duration-300 data-[scrolling]:opacity-100 data-[scrolling]:duration-0`（仅 `data-scrolling` 瞬现；停手 → 失去 scrolling → `duration-300` 渐隐。**不用 `data-[hovering]`**）。
  - Thumb：`w-1.5 rounded-full bg-foreground/35`（暗色经 `--foreground` 自动反相，对比足够）。
  - 浮在右缘、不占布局（不在 Content 上留 padding/gutter）。
- **变体名待实测**：Base UI 的 `data-hovering`/`data-scrolling` 为布尔存在属性，Tailwind v4 用 `data-[hovering]:`/`data-[scrolling]:` 匹配；若实测变体未生效（参照此前 tabs `data-orientation` 错配坑），在 `src/index.css` 补 `@custom-variant` 映射。

## §2 · `src/index.css`（改）

加 Tailwind v4 工具类，供阅读区与任意需隐原生条处复用：

```css
@utility scrollbar-hide {
  scrollbar-width: none; /* Firefox */
  &::-webkit-scrollbar {
    display: none;
  } /* WebKit/Chromium */
}
```

> `@utility` 定义始终产出、不依赖类扫描，故在 `@marginalia/virtual-docs` 包内以字符串形式使用也有效。

## §3 · `@marginalia/virtual-docs`（改，epub-agnostic）

- `VirtualDocsProps` 加可选 `className?: string`，转发给 `<Virtuoso className={className} … />`（Virtuoso 将 `className` 应用到其 scroller 根元素）。
- 保持包通用性：包本身不内置「隐藏滚动条」语义，由调用方（EpubReader）传 `scrollbar-hide`。

## §4 · `reader/EpubReader.tsx`（改）

- 给 `<VirtualDocs … />` 传 `className="scrollbar-hide"` → 阅读区彻底无原生条、无 thumb（DD-1）。
- 第 179 行附近「捕获阶段监听 document 的 scroll」逻辑不受影响（仍监听 Virtuoso scroller 的滚动，只是视觉无条）。

## §5 · 消费方改造（7 处外壳容器）

每处由「裸 `overflow-y-auto` div」改为 `<ScrollArea>` 包装：尺寸/高度上下文类挪到 Root（`className`），原内层布局元素（含 padding/flex/gap）作为 children 进 Content，**去掉原 `overflow-y-auto`**。

| 文件                         | 现状类                                                           | 改法                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reader/ChapterList.tsx`     | `nav flex h-full flex-col gap-0.5 overflow-y-auto p-2`           | `<ScrollArea className="h-full">` 包 `<nav className="flex flex-col gap-0.5 p-2">`                                                                                                                |
| `reader/AnnotationsList.tsx` | `div h-full space-y-1.5 overflow-y-auto p-2`                     | 同上模式                                                                                                                                                                                          |
| `reader/BookCard.tsx`        | `div max-h-96 overflow-y-auto …`                                 | 尺寸 `max-h-96` 挪 Root                                                                                                                                                                           |
| `settings/SettingsShell.tsx` | nav `w-48 … overflow-y-auto` + 内容 `flex-1 overflow-y-auto p-6` | **两处独立** `<ScrollArea>`；注意 `border-e`/`min-w-0` 等布局类的归属（边框留外层或 Root）                                                                                                        |
| `library/LibraryView.tsx`    | `main flex-1 overflow-y-auto p-6`                                | `flex-1` 挪 Root，网格作 children                                                                                                                                                                 |
| `ai/AIPanel.tsx`             | `div ref={scrollRef} min-h-0 flex-1 overflow-y-auto p-4`         | `<ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>`；**`scrollRef` 改指 Viewport**，第 25 行 `el.scrollTo({ top: el.scrollHeight, behavior:"smooth" })` 不变（Viewport 即滚动元素） |
| `ai/ChipBar.tsx`             | popover 内 `max-h-40 w-80 overflow-y-auto …`                     | `w-80` 等外观留浮卡容器；`max-h-40` 滚动部分包 `<ScrollArea>`                                                                                                                                     |

> 各处 `t()` 文案、事件、ref 语义均不变，仅 DOM 结构与滚动归属调整。

## §6 · 测试与验收

- **无新单测**：thumb 数学/拖拽/淡入淡出全是 Base UI 拥有，无纯逻辑可测（与封面墙、右键删书组件「手测」一致）。`scrollbar-hide` 是 CSS、`className` 透传是 1 行——无可单测逻辑。
- **`pnpm typecheck` + `pnpm lint`** 必过。
- **手测清单**（`pnpm start`，逐容器）：
  - 阅读区：滚动全程**无任何条**（原生消失、无 thumb）✓
  - 7 处外壳容器，逐处：原生条消失 ✓ / 内容溢出时 thumb 现、不溢出时无 thumb ✓ / **滚动时淡入、停手淡出**（悬停整区不应显示）✓ / thumb 可拖拽滚动且拖时不选中文本 ✓ / 暗色下 thumb 对比可见 ✓ / 无布局回归（高度/flex/padding 正确）✓
  - AIPanel：发新消息仍平滑自动滚底 ✓
- 加 Base UI 组件后按记忆惯例确认 `@base-ui/react` 已装（`^1.5.0`，无新依赖）；若 `pnpm install` 被触发，`postinstall` 自动 `db:rebuild:electron` 翻回 Electron ABI。

## §7 · 风险

- **逐容器布局回归**：滚动归属从单 div 改为 Root/Viewport/Content 三层，高度上下文（`h-full`/`flex-1`/`min-h-0`）、flex、padding 错位风险——逐处手测兜底。SettingsShell 两处 + 边框/`min-w-0` 归属最易错。
- **Base UI 变体名**：`data-[hovering]`/`data-[scrolling]` 若未生效，补 `@custom-variant`（参照 tabs `data-orientation` 坑）。
- **overlay thumb 遮内容**：浮条压在内容极右缘——thumb 细且仅滚动时可见，可接受；个别容器按需补 `pe-*`。

## §8 · 范围外（YAGNI）

- 阅读区虚拟化自绘 thumb（DD-1 延后到「精度/内存 pass」）。
- 横向滚动条（仅竖向）。
- 点击空轨道翻页（DD-3）。
- `Composer.tsx` textarea / `select.tsx` 弹层（DD-6 排除）。
- 迁移 ui-prototype `ScrollArea.tsx`（DD-2 改用 Base UI 原语，原型 `ScrollArea.tsx` 仅原型内继续用，不动）。

## 设计决策记录（速查）

- **DD-1**：阅读区彻底无条（隐原生 + 无 thumb，仅竖向；虚拟化 thumb 延后精度 pass）。
- **DD-2**：其余容器用 Base UI ScrollArea 原语（非迁自搓原型）。
- **DD-3**：可拖拽 thumb，轨道不可点。
- **DD-4**：macOS 细 overlay 审美（`w-1.5 rounded-full bg-foreground/35`，浮右缘不占布局，**仅滚动时显示、停手渐隐**，不认 hover）。
- **DD-5**：新增 `components/ui/scroll-area.tsx` shadcn 风包装（仿 popover，不跑 CLI）。
- **DD-6**：7 处外壳容器换条；Composer/Select 排除。
