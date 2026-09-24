# ReaderView 三向可收起布局（PeekDrawer）设计

> **日期**：2026-06-04
> **分支**：待建（基于 main）
> **状态**：设计定稿，待 plan
> **关联**：UP1 原型 `packages/ui-prototype/src/components/AppShell.tsx` 的 `PeekDrawer`/`Workspace`/`TopBar`；现状 `src/renderer/reader/ReaderView.tsx`

## 背景

当前 `ReaderView` 是固定三栏：header（h-12，不可收）+ 左栏 Sidebar（w-64，不可收）+ 正文 + 右栏 AIPanel（w-96，经 `chat-store.panelOpen` 用 `hidden` 类开合——无动画、无收起后的唤出途径，且**刻意始终挂载**以保住 `useChat` 流式对话状态）。

UP1 原型已实现三向可收起：收起后边缘保留 3px 热区 + 1px 把手，hover 即滑出浮层（`transition-transform duration-200 ease-out`），移开 200ms 自动收回（`PeekDrawer`，AppShell.tsx L177-235）。但原型用**双挂载点条件渲染**（展开态 `<aside>` 与收起态 `<PeekDrawer>` 各挂一份、二选一）——直接照搬会让 AIPanel 在开合瞬间卸载重挂、丢失流式状态，与现有保活约束冲突。

`panelOpen` 还有布局之外的消费方：`use-ai-actions.ts`（选区提问自动弹面板）、`Composer.tsx`（开面板聚焦输入框）、`AIPanel.tsx`（面板内关闭按钮）、`SummaryPill.tsx`（面板开着才查摘要）。

## 设计决策（已与用户确认）

- **DD-1 交互完整移植 PeekDrawer**。三方向（左栏/右栏/header）行为一致：收起后 3px 边缘热区 + 1px 把手，hover 滑出浮层、移开 200ms 收回，参数照原型（`duration-200 ease-out`、`z-30` 热区 / `z-40` 浮层、`shadow-xl`）。
- **DD-2 单挂载点 `CollapsiblePane`**，否决原型的双挂载点条件渲染。每个面板始终挂在同一树位置，容器按 `open` 切换「文档流占位 / absolute overlay」两种 className 模式——children 不卸载，`useChat` 流式状态、Sidebar 滚动位置全保活。亦否决 grid 列宽过渡动画（方案 C）：复杂度高、原型本就是瞬间回流，YAGNI。
- **DD-3 三态持久化为单 preference key `readerLayout`**（`{ sidebarOpen, panelOpen, headerOpen }` 对象，与 `readerPrefs` 同模式），存于 prefs-store（应用落盘偏好的单一家）；`chat-store.panelOpen` **迁移**至 prefs-store，chat-store 删除该字段。
- **DD-4 首启默认布局：左开 / 顶开 / 右关**。保持现状语义——阅读优先，AI 面板由用户主动唤出（选区提问仍自动弹出）。
- **DD-5 本期无快捷键**。PeekDrawer 已覆盖「收起后如何唤出」；快捷键留待全局快捷键体系统一规划。
- **DD-6 组件内部统一物理类**。`left-0`/`right-0`/`top-0` 定位、`-translate-x-full`/`translate-x-full`/`-translate-y-full` 隐藏、`border-r`/`border-l`/`border-b` 分隔线。理由：CSS transform 是物理坐标、无逻辑变体，逻辑定位类（`start-0` 随 RTL 翻边）+ 物理 translate 混用在 RTL 下错位；`side` prop 本就是物理语义，三者统一物理永远自洽。
- **DD-7 header 按钮编排**（对齐原型 TopBar）：左侧 `PanelLeftClose/Open` 切左栏（新增）→ 返回书库；右侧 `ReaderPrefs` → AI 面板切换（图标 `MessageSquare` 改 `PanelRightClose/Open`，去 `text-primary` 高亮，开合语义由图标表达）→ 设置 → `PanelTopClose/Open` 收起 header（新增，最右）。AIPanel 自带关闭按钮保留。

## 架构 / 组件树

```
<div relative flex h-screen flex-col>                    ← header overlay 定位锚
  <CollapsiblePane side="top" open={headerOpen} sizeClass="h-12">
    <header>…按钮编排见 DD-7…</header>
  </CollapsiblePane>
  <div relative flex min-h-0 flex-1>                     ← 左右 overlay 定位锚
    <CollapsiblePane side="left" open={sidebarOpen} sizeClass="w-64">
      <Sidebar bookId />
    </CollapsiblePane>
    <main min-w-0 flex-1> <EpubReader … /> </main>
    <CollapsiblePane side="right" open={panelOpen} sizeClass="w-96">
      <AIPanel />
    </CollapsiblePane>
  </div>
  <SelectionToolbar /> <HighlightStyleBar /> <NoteModal />   ← 不动
</div>
```

左右浮层锚在正文区容器（收起左栏的浮层只覆盖 workspace 高度、不遮 header）；header 浮层锚在最外层（`inset-x-0 top-0`），覆盖正文不挤压。

## §1 · `reader/CollapsiblePane.tsx`（新）

```tsx
interface CollapsiblePaneProps {
  side: "left" | "right" | "top";
  open: boolean; // 钉住（文档流占位）
  sizeClass: string; // "w-64" / "w-96" / "h-12"
  label: string; // 热区 aria-label
  className?: string; // 追加到面板元素（如左栏 bg-muted/30）
  children: ReactNode;
}
```

- **单一面板元素**，className 按模式切换（children 树位置不变 → React 不卸载）：
  - `open=true`：`shrink-0 ${sizeClass}` + 按 side 分隔边框（左 `border-r` / 右 `border-l` / 顶 `border-b`，沿用 `border-border`）。左栏的 `bg-muted/30` 由调用方经 `className` 传入（两种模式都追加，收起浮层同底色）。
  - `open=false`：`absolute z-40 bg-background shadow-xl transition-transform duration-200 ease-out ${sizeClass}` + 按 side 贴边（左 `inset-y-0 left-0` / 右 `inset-y-0 right-0` / 顶 `inset-x-0 top-0`）+ 同侧分隔边框；未 peek 时按 side 加 `-translate-x-full` / `translate-x-full` / `-translate-y-full`，peek 时移除位移类（`translate-x-0 translate-y-0`，照原型）。
- **收起态额外渲染兄弟热区**（无状态，可条件渲染）：贴边 3px（`w-3`/`h-3`）`z-30`，内含 1px 把手（`bg-border/60`，group-hover `bg-primary/40`）。
- **peek 内部状态**：`peekOpen: boolean` + 收回 timer ref。热区 mouseEnter → 取消计时 + `peekOpen=true`；浮层 mouseEnter → 取消计时；浮层/热区 mouseLeave → 200ms 后 `peekOpen=false`。`open` 翻转为 true 时重置 peek 态并清计时器（卸载时同样清理）。
- 渲染层启用 React Compiler：不手写 useCallback/useMemo；timer 清理的命令式 effect 照常手写。

## §2 · `reader/ReaderView.tsx`（改)

- 三个面板按上述组件树包进 `CollapsiblePane`；右栏现有 `hidden` 开合逻辑删除（被 CollapsiblePane 取代，保活语义不变且更好——收起后 hover 还能看到流式中的回复）。
- header 内容整体作为 `side="top"` 的 children；收起态下浮层里的 `PanelTopOpen` 按钮是恢复钉住的唯一途径（与原型一致）。
- 布局开关从 `usePrefsStore` 读：`layout.sidebarOpen` / `layout.panelOpen` / `layout.headerOpen`，切换走 `updateLayout(patch)`。

## §3 · `shared/preferences.ts`（改）

```ts
export const readerLayoutSchema = z.object({
  sidebarOpen: z.boolean(),
  panelOpen: z.boolean(),
  headerOpen: z.boolean(),
});
```

- `PREFERENCE_SCHEMAS` 注册 `readerLayout`；`setPreferenceInput` 补对应 arm（`preferences.test.ts` 的同步测试强制此步）。

## §4 · `store/prefs-store.ts` + `store/hydrate-preferences.ts`（改）

- prefs-store 加 `layout: ReaderLayout`（初值 `{ sidebarOpen: true, panelOpen: false, headerOpen: true }`，DD-4）与 `updateLayout(patch: Partial<ReaderLayout>)`：合并 → `persistPreference({ key: "readerLayout", value: 整对象 })` → set（仿 `updatePrefs`）。
- hydrate-preferences 加：`if (snap.readerLayout) usePrefsStore.setState({ layout: snap.readerLayout })`（setState 直写，不触发回写）。

## §5 · chat-store 迁移（`panelOpen` 搬家）

`chat-store` 删除 `panelOpen`/`setPanelOpen`/`CHAT_INITIAL.panelOpen`，消费方机械迁移：

| 文件                   | 改动                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `ai/use-ai-actions.ts` | `usePrefsStore.getState().updateLayout({ panelOpen: true })`  |
| `ai/Composer.tsx`      | 改读 `usePrefsStore((s) => s.layout.panelOpen)`，聚焦行为不变 |
| `ai/AIPanel.tsx`       | 关闭按钮 → `updateLayout({ panelOpen: false })`               |
| `ai/SummaryPill.tsx`   | 改读 prefs-store，查询门控（`enabled: panelOpen && …`）不变   |

副作用：选区提问自动弹面板现在会落盘（用户上次布局 = 面板开）——语义合理，它就是用户最后看到的布局。收起态下自动弹出表现为**直接钉住**（文档流占位），不走 peek 浮层，保证提问时面板稳定可见。

## §6 · 测试与验收

- **vitest（自动）**：
  - `shared/preferences.test.ts`：既有「PREFERENCE_SCHEMAS ↔ setPreferenceInput arms 同步」测试自动覆盖新 key。
  - `store/prefs-store.test.ts`：补 `updateLayout` 合并语义 + `persistPreference` 调用断言（整对象、key 正确）。
  - `store/chat-store.test.ts`：删 panelOpen 相关断言。
  - 组件不进单测（vitest Node 环境、仅收 `*.test.ts`，无 DOM）。
- **`pnpm typecheck` + `pnpm lint`** 必过。
- **手测清单**（`pnpm start`）：
  - 三向各自：header 按钮收起 → 边缘现 1px 把手 ✓ / hover 3px 热区滑出浮层 ✓ / 移开 200ms 收回、期间移回则取消 ✓ / 浮层内点击钉住按钮恢复占位 ✓
  - **AI 回复流式中收起右栏 → hover 唤出，回复仍在流式渲染（保活）** ✓
  - 重启应用恢复上次布局 ✓；清 userData 首启默认「左开/顶开/右关」 ✓
  - 选区提问：右栏收起时自动钉住展开、输入框聚焦 ✓
  - 全收起（三者皆收）：正文满屏可读，三边把手均可唤出 ✓

## §7 · 风险

- **右缘热区 vs 自绘滚动条**：右栏收起时 3px 热区（z-30）覆盖正文滚动条最右 3px 的 hover/拖拽命中区。thumb 实际可点宽度 ≥8px，影响轻微，接受；如实测碍手，再缩热区到 2px。
- **z-index 与选区浮层**：SelectionToolbar 等在 `z-50+`，不会被 peek 浮层（z-40）遮住；反向 peek 浮层可能盖住边缘附近的选区 UI——与原型同取舍，接受。
- **in-flow ⇄ absolute 切换的回流闪动**：收起瞬间正文立即回流占满（无宽度过渡）——与原型行为一致，预期内。

## §8 · 范围外（YAGNI）

- 快捷键（DD-5，留待全局快捷键体系）。
- 宽度回流过渡动画（方案 C，已否决）。
- RTL 适配（当前仅中英文，`side` 物理语义，DD-6）。
- 边栏宽度拖拽调节、记忆面板内 tab 状态等增强。

## 设计决策记录（速查）

- **DD-1**：完整移植 PeekDrawer（3px 热区 / 1px 把手 / 200ms 延时收回 / duration-200 ease-out）。
- **DD-2**：单挂载点 CollapsiblePane（保活），否决双挂载点与 grid 动画。
- **DD-3**：`readerLayout` 单 preference key；panelOpen 迁 prefs-store。
- **DD-4**：首启默认左开/顶开/右关。
- **DD-5**：本期无快捷键。
- **DD-6**：组件内统一物理类（定位/translate/边框）。
- **DD-7**：header 按钮编排——左 PanelLeft+返回；右 ReaderPrefs+PanelRight+设置+PanelTop。
