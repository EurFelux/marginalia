# 悬停带笔记的高亮时显示笔记 hover card 设计

日期：2026-06-08
状态：待用户 review（2026-06-08 brainstorming 已对齐）
关联：GitHub issue #58（`polish` / `area:reader`，P1）。用户需求：阅读时无法就地瞥见某高亮是否带笔记、笔记内容是什么——只能开侧栏 `AnnotationsList` 或点进 `NoteModal`。期望：悬停带笔记的高亮即弹卡片显示笔记，ePub / PDF 均生效。

## 1. 背景与动机

笔记（note）目前只在两处可见：侧栏标注列表（`AnnotationsList`）与笔记编辑弹窗（`NoteModal`）。阅读正文时，高亮本身不提供任何「这条带笔记」的就地反馈——带笔记的高亮虽有 `.anno-noted` 虚线下划线（ePub）作弱提示，但要读到笔记内容必须离开正文。

本功能补上「就地瞥见」：悬停带笔记的高亮 → 卡片显示该笔记。**纯渲染层改动**，主进程零改动——`note` / `selectedText` / `locatorRange` 数据早已齐备（`AnnotationDto`，`src/shared/annotations.ts`；`annotations` 表，`src/main/db/schema.ts:129`）。

### 1.1 现状盘点（功能所需零件已大半就位）

| 能力                    | 现状                                                                                                                                  | 位置                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 区分有/无笔记           | `note.trim().length > 0`                                                                                                              | ePub：`apply-annotations.ts:67` 给带笔记 mark 加 `.anno-noted`；PDF：`HighlightRect.hasNote`（`use-pdf-highlights.ts:15`） |
| 反查 annotation id      | ePub mark 挂 `data-anno-id`（`apply-annotations.ts:42`）；PDF `HighlightRect.annoId` + `hitHighlight()`（`use-pdf-highlights.ts:19`） |
| 笔记数据                | `qk.annotations(bookId)` React Query 缓存（`staleTime:Infinity`）                                                                     | `EpubReader.tsx:71`、PDF 同源                                                                                              |
| 浮层组件                | `HoverCard`（封装 `@base-ui/react` PreviewCard）                                                                                      | `src/renderer/components/ui/hover-card.tsx`                                                                                |
| 笔记展示样式            | `✎ + note`（`AnnotationsList.tsx:122`）                                                                                               |
| ePub 跨 iframe 事件管道 | `SectionFrame` 已把 iframe 内 click→主文档回调（`onHighlightClick`）                                                                  | `SectionFrame.tsx:105`、`toViewportRect()` 坐标转换                                                                        |
| PDF 命中管道            | `PdfPage` 容器 `onMouseMove` 已 `hitHighlight` 做 pointer cursor                                                                      | `PdfReader.tsx:413`                                                                                                        |

### 1.2 核心难点：跨 iframe 的「可移入」协调

用户已确认交互为 **可移入卡片**（鼠标能从高亮移到卡片上读长笔记 / 点编辑按钮）。难点在两个 reader 都没有可供 PreviewCard 内建 hover-intent 绑定的「真实 trigger 元素」：

- **ePub**：mark 活在 iframe 文档内。鼠标从 mark 移到主文档的卡片，必然**先离开 iframe**（穿过 iframe 边界与 `sideOffset` 间隙）。PreviewCard 的内建 hover 协调靠 trigger/popup 同处一文档，跨文档边界后失效。
- **PDF**：overlay 是 `pointer-events-none` 纯视觉层（不挡划词），命中走容器 `onMouseMove` + `hitHighlight`，没有逐高亮的真实 DOM 元素。

结论：**「mark 离开→延迟关→卡片进入→取消关」的安全 hover 状态机必须自己实现**，且两 reader 共用。这正是抽共享 hook 的理由（呼应项目惯例「横切逻辑抽消费侧 hook、核心做纯函数可单测」）。

## 2. 决策摘要

| 决策点          | 结论                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| 改动层          | 纯渲染层；主进程 / DB / IPC 零改动                                                                     |
| 架构            | 各 reader 做「命中适配」→ 共享 `useNoteHoverCard` 状态机 → 单一 `<NoteHoverCard/>` 展示                |
| 安全 hover 逻辑 | 抽纯函数 reducer（事件→下个状态 + 定时器指令），hook 包定时器；reducer 单测                            |
| 浮层原语        | **方案 A（受控 PreviewCard + 虚拟锚点）**；实现不顺则退**方案 B（自绘 fixed 卡片）**                   |
| 卡片内容        | 笔记正文 + `[✎ Edit]` 按钮（不重复引文——悬停的高亮选区本身即引文）                                     |
| 编辑入口        | 点 Edit → 关卡片 + `openNoteModal({target:{type:"edit",annotationId}})`（进笔记编辑，非综合 styleBar） |
| 触发条件        | 仅带笔记的高亮（ePub 看 `.anno-noted`，PDF 看 `hasNote`）；空笔记绝不触发                              |
| 挂载点          | `ReaderView` 末尾那排 store 驱动浮层（`SelectionToolbar`/`HighlightStyleBar`/`NoteModal`）旁           |

## 3. 架构与数据流

```
ePub: SectionFrame iframe mousemove ──┐
       (closest[data-anno-id] + 视口rect)│
                                        ├─► useNoteHoverCard ──► <NoteHoverCard/>
PDF:  PdfPage 容器 onMouseMove ─────────┘   (安全定时器 + 受控状态)   (按 annoId 查 note 渲染)
       (hitHighlight + 视口rect)
```

跨 reader 只有两处不同：**怎么命中高亮** 与 **怎么把命中矩形换算成视口 rect**。展示、定位、进出协调只有一份。

## 4. 共享层

### 4.1 安全 hover 状态机（纯函数 + hook）

**纯 reducer**（独立文件，便于单测）：

```ts
// note-hover-machine.ts（示意，非最终签名）
interface HoverState {
  annoId: string | null;
  anchorRect: ViewportRect | null;
  open: boolean;
}
type HoverEvent =
  | { type: "enterHighlight"; annoId: string; rect: ViewportRect }
  | { type: "leaveHighlight" }
  | { type: "enterCard" }
  | { type: "leaveCard" }
  | { type: "closeNow" }; // 定时器到期 / 滚动强关
// 返回下一状态 + 定时器指令，副作用（setTimeout）留给 hook
function reduce(state, event): { next: HoverState; timer: "start" | "cancel" | "none" };
```

转换规则：

- `enterHighlight`：`open=true`、写 `annoId`/`anchorRect`、`timer:"cancel"`。**幂等**——同 `annoId` 已 open 时不重置（仅可选更新 `anchorRect`），避免连续 mousemove 与多片段间移动闪烁。
- `leaveHighlight`：`timer:"start"`（启动 ~150ms 关闭窗口，给鼠标移到卡片的时间），状态暂不变。
- `enterCard`：`timer:"cancel"`（鼠标进卡片，取消关闭）。
- `leaveCard`：`timer:"start"`。
- `closeNow`：`open=false`、`annoId=null`、`timer:"cancel"`。

**`useNoteHoverCard()` hook**：持 `HoverState`，用 `useRef` 管定时器；暴露给命中适配的 `hoverHighlight(annoId, rect)` / `leaveHighlight()`，给卡片的 `onCardEnter` / `onCardLeave`，以及给「滚动即关」的 `closeNow()`。延迟常量复用现有 `HoverCard` 的 `closeDelay=150`，打开延迟可设 0~150（卡片本身靠 mousemove 已是「停留」语义，不必再叠 300ms）。

### 4.2 `<NoteHoverCard/>` 展示组件

挂在 `ReaderView`（`ReaderView.tsx:232-234` 那排浮层旁）。按 `useNoteHoverCard` 的 `annoId` 从 `qk.annotations(bookId)` 缓存查出该条 `AnnotationDto`，渲染：

- 笔记正文（卡片唯一主体内容）：复用 `AnnotationsList.tsx:122` 的 `✎ + note`，长笔记 `max-h-*` + 内部滚动。**不重复引文**：卡片悬停在高亮选区上弹出，选区文字用户正看着，再 blockquote 一遍冗余；
- 底部 `[✎ Edit]`：点击 `closeNow()` + `openNoteModal({target:{type:"edit",annotationId}})`（`annotation-store.ts:30`、`AnnoTarget` 的 edit 分支）。

组件根挂 `onMouseEnter={onCardEnter}` / `onMouseLeave={onCardLeave}`。`bookId` 从 `useNavigationStore` 取（同 `ReaderView`）。无 `annoId` 或查不到该条 → 不渲染卡片。

### 4.3 浮层原语

- **方案 A（推荐）**：受控 `PreviewCard` + 虚拟锚点。扩展 `hover-card.tsx` 的 `HoverCardContent` 多接一个 `anchor`（透给 `PreviewCardPrimitive.Positioner` 的 `anchor`，传虚拟元素 `{ getBoundingClientRect: () => anchorRect }`）。`HoverCard` 根用受控 `open`（hook 的 `open`）。白拿 Base UI 的上下翻转 / 视口碰撞 / Portal / 动画。**风险**：受控且不渲染真实 `Trigger` 是 Base UI 非常规用法——实现首步即验证（必要时塞一个 0 尺寸隐藏 trigger 占位以满足其内部约束）。
- **方案 B（fallback）**：自绘 `fixed` 卡片，`left/top` 由 `anchorRect` 运行时计算（规范允许内联承载计算值，见 CLAUDE.md「UI 样式」）。无第三方协调风险，代价是自己写上下翻转 + 视口边界裁剪。

无论 A/B，安全定时器都在 hook 里自己写；A 的红利仅剩定位翻转，故若 A 受阻立即退 B，不纠缠。

## 5. ePub 命中适配

顺着 `SectionFrame` 现有 `onAnnoClick`（`SectionFrame.tsx:105`）模板新增一组 hover 透出：

- iframe `mousemove`（可复用现有 `onContentMove`，`SectionFrame.tsx:139`，或并列新增）里 `closest("[data-anno-id]")`：
  - 命中且该 mark 带 `.anno-noted`（带笔记）→ 回调 `onHighlightHover(annoId, toViewportRect(el.getBoundingClientRect(), iframe.getBoundingClientRect()))`；
  - 未命中（或命中无笔记 mark）→ 回调 `onHighlightLeave()`。
- 仅对 `.anno-noted` 触发，从源头滤掉无笔记高亮（也可在 hook 侧用数据判断，二选一，倾向 `.anno-noted` 类——零额外查表）。

新 prop（`onHighlightHover` / `onHighlightLeave`）经 `SectionFrame`（含 `cbRef`）→ `VirtualDocs`（`LazySection` 透传 + `itemContent` 的 `useCallback` deps）→ `EpubReader` 机械透传。**注意**：virtual-docs 包不过 React Compiler（`VirtualDocs.tsx:107` 注释），所有透传回调必须手动 `useCallback` 稳定身份。`EpubReader` 把回调接到 `useNoteHoverCard` 的 `hoverHighlight`/`leaveHighlight`。

## 6. PDF 命中适配

在 `PdfPage` 现有 `onMouseMove`（`PdfReader.tsx:413`，已 `hitHighlight` 做 pointer cursor）里追加：命中且 `hit.hasNote` → `hoverHighlight(hit.annoId, 视口rect)`；否则 `leaveHighlight()`。视口 rect 沿用 `onClick`（`PdfReader.tsx:398`）的换算：`{ x: hit.rect.left + base.x, y: hit.rect.top + base.y, width, height }`（`base = textLayer.getBoundingClientRect()`）。`onMouseLeave`（`PdfReader.tsx:424`）顺手 `leaveHighlight()`。

`useNoteHoverCard` 由 `PdfReader` 顶层持有并下传给各 `PdfPage`（或经 store；倾向 props 下传，作用域清晰）。

## 7. 边界与降级

- **一条标注多片段**（跨行 = 多 mark / 多 rect，同 `annoId`）：reducer 的 `enterHighlight` 幂等 + 150ms 关闭窗口，使片段间移动不闪烁。
- **滚动**：沿用现有「滚动即关浮层」逻辑（`EpubReader.tsx:220` 捕获阶段 scroll；PDF 同源）顺手 `closeNow()`——锚点视口坐标滚动后失真。
- **长笔记**：卡片 `max-h-*` + 内部滚动（可移入，能滚着读）。
- **空笔记高亮**：绝不触发（§5/§6 源头过滤）。
- **与 click→styleBar 共存**：hover 出卡片、click 仍开样式栏，互不干扰（hover 与 click 事件正交）。
- **换书 / 切章**：annoId 失效时卡片查不到 `AnnotationDto` → 不渲染；滚动关闭已覆盖大部分场景。

## 8. 测试策略

- **reducer 纯函数单测**（核心）：进 mark→open、离 mark→延迟关、进卡片→取消关、离卡片→关、同 id 多片段不重置、closeNow→清空。覆盖定时器指令（`start`/`cancel`/`none`）而非真实计时。
- `hitHighlight`（PDF 命中）已是纯函数、已有覆盖。
- 坐标换算复用既有 `toViewportRect`（已被选区 / click 路径验证），不重复测。
- 手动冒烟：ePub 与 PDF 各验「悬停带笔记高亮弹卡片 / 移入卡片不消失 / 点 Edit 进 NoteModal / 悬停无笔记高亮不弹 / 滚动关闭」。

## 9. 不做（YAGNI）

- 卡片内联编辑笔记（走 NoteModal）；
- 点击 pin 卡片 / 卡片常驻；
- CFI 失效时 selectedText 重锚定（沿用现有跳过策略）；
- 移动端 / 触屏长按等非鼠标交互。

## 10. 文件改动清单（供 writing-plans 拆解）

**新增**：

- `src/renderer/reader/note-hover-machine.ts`：纯 reducer + 类型。
- `src/renderer/reader/note-hover-machine.test.ts`：reducer 单测。
- `src/renderer/reader/use-note-hover-card.ts`：hook（定时器 + 状态）。
- `src/renderer/reader/NoteHoverCard.tsx`：展示组件。

**修改**：

- `src/renderer/components/ui/hover-card.tsx`：`HoverCardContent` 增 `anchor` 透传（方案 A）。
- `packages/virtual-docs/src/SectionFrame.tsx`：iframe mousemove hover 检测 + `onHighlightHover`/`onHighlightLeave` 回调（含 `cbRef`）。
- `packages/virtual-docs/src/VirtualDocs.tsx`：新 prop 透传（`LazySection` + `itemContent` deps）。
- `src/renderer/reader/EpubReader.tsx`：接 hover 回调到 `useNoteHoverCard`。
- `src/renderer/reader/PdfReader.tsx`：`onMouseMove`/`onMouseLeave` 接 hover 回调。
- `src/renderer/reader/ReaderView.tsx`：挂 `<NoteHoverCard/>`。
- i18n：卡片「Edit」按钮文案（按 `i18n` 既有流程 extract）。
