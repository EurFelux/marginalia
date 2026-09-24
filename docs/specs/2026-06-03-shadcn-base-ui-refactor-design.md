# 渲染层 UI 重构到 shadcn（Base UI 基底）· 设计文档

> 状态：范围已确认（用户 2026-06-03）。决策：**全量基础原语 + 消费方接入**；**Base UI 优先**（非 Radix）；用 **shadcn CLI** 导入（现默认 Base UI）；选区浮动工具栏本轮**只换内部按钮、保留 RA3 自定义逻辑**，迁 Base UI Popover 记入 ROADMAP 后续。

## 1. 背景与现状

渲染层（`src/renderer/`）竖切重建时未 scaffold shadcn：组件全部手搓 Tailwind+HTML，无 CVA（虽已装 `class-variance-authority`）、无 Radix、无 `components.json`。手搓的 modal/popover 缺**焦点陷阱、ESC 关闭、点外关闭、键盘导航**等 a11y 行为。

探查结论（关键）——底座已就位，只缺组件层：

| 层           | 现状                                                                                                                                                                                            | 距离 shadcn |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Token 层** | `src/index.css` 已是完整 shadcn 变量（oklch + light/`.dark` + sidebar/radius/chart）+ `@theme inline`；组件已在用 `bg-primary`/`text-muted-foreground`/`border-border`/`bg-popover`/`ring-ring` | ✅ 0        |
| **`cn` 层**  | `src/renderer/lib/utils.ts` 已有标准 `cn`（clsx + twMerge）                                                                                                                                     | ✅ 0        |
| **组件层**   | 全手搓，无 CVA/Radix/Base UI                                                                                                                                                                    | 🔴 100%     |

## 2. 技术选型

- **无头基底：Base UI**（`@base-ui/react`，最新 1.5.0，peer 支持 React 19）。Radix 原班人马的新库；shadcn CLI 现默认用它。
  - 样式：每个 part 收 `className`（字符串或 state 函数），直接 Tailwind；状态走 `data-*`（`data-open`/`data-checked`/`data-popup-open`/`data-highlighted`/`data-selected`…）；进出场动画用 `data-starting-style`/`data-ending-style` + `transition`（**不引** tw-animate-css）。
  - 多态组合：`render` prop（Base UI 版 `asChild`，**不需** Radix Slot）——把 `Dialog.Trigger`/`Close` 等渲染为我们的 CVA `Button`。
  - anatomy：Dialog `Root>Trigger>Portal>Backdrop>Viewport>Popup>(Title/Description/Close)`；Popover `Root>Trigger>Portal>Positioner>Popup`；Tabs `Root>List>Tab>Panel(+Indicator)`；Checkbox `Root>Indicator`；Tooltip `Provider>Root>Trigger>Positioner>Popup`。
- **导入方式：shadcn CLI**（`pnpx shadcn@latest init` + `add`）。CLI 生成 Base-UI 版 `components/ui/*`、装 `@base-ui/react`、写 `components.json`。
- **底座复用**：`components.json` 配 `cssVariables: true` 指向**现有** `src/index.css`（不重写 token）、`utils` 指向**现有** `src/renderer/lib/utils.ts`（不覆盖 `cn`）。

## 3. 集成注意（本仓特殊性，CLI 须人工核验）

1. **路径别名**：renderer 在 `src/renderer/`，别名 `@renderer`/`@shared`（见 tsconfig + 各 vite config）。`components.json` 的 `aliases` 须配 `components: "@renderer/components"`、`ui: "@renderer/components/ui"`、`utils: "@renderer/lib/utils"`、`lib: "@renderer/lib"`、`hooks: "@renderer/hooks"`。CLI 可能按单包 Electron 项目误判，**init 后逐项核对**。
2. **不得覆盖既有资产**：`src/index.css` 的 token 与 `@theme inline`、`src/renderer/lib/utils.ts` 的 `cn`——init/add 若试图改写，保留现有、丢弃其改动（git diff 审）。
3. **Tailwind v4 CSS-first**：无 config 文件。CLI 须走 v4 模式（cssVariables）。`components/ui/kbd.tsx` 已存在（手搓），本轮**统一改为 CVA / 与新组件风格一致**。
4. **ABI 翻转**：CLI `add` 装 `@base-ui/react` 触发 `pnpm install` → better-sqlite3 重编为 Node ABI 137；装完跑 `pnpm db:rebuild:electron` 翻回 145，再 `pnpm test`（见 CLAUDE.md）。
5. **React Compiler**：渲染层已启用（`vite.renderer.config.ts`）。Base UI 预编译发布、不受我们的 Compiler 转译影响；我们用法是把 Base UI 当 JSX 子节点组合，无已知冲突。落地手测确认（modal 焦点、popover 定位、动画）即可。
6. **`pnpx` 非 `npx`**（全局约束）。

## 4. 范围：原语清单 + 消费方接入映射

**建立的原语**（`components/ui/`，CLI 生成 + 按需调样式）：`button`、`input`、`textarea`、`checkbox`、`dialog`、`popover`、`tabs`、`tooltip`、`card`、`kbd`（改 CVA）。

**消费方迁移映射**：

| 原语               | 接入的现有组件                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dialog**         | `NoteModal`（笔记编辑 modal）、`SettingsPanel`（设置 modal）——替换手搓全屏遮罩，获得焦点陷阱 + ESC + 点外关闭                                                                                         |
| **Popover**        | `ReaderPrefs`（阅读偏好浮层）、`SummaryPill`（摘要浮卡）、`ChipBar`（chip 悬停弹窗）——替换手搓 absolute/portal 定位                                                                                   |
| **Tabs**           | `Sidebar`（目录/标注切换）——获得 tablist/tab/panel 语义 + 键盘导航                                                                                                                                    |
| **Checkbox**       | `SettingsPanel`（自动摘要开关）                                                                                                                                                                       |
| **Input/Textarea** | `SettingsPanel`（API Key）、`NoteModal`（笔记 textarea）、`Composer`（AI 输入）                                                                                                                       |
| **Button**         | 全局：`SelectionToolbar`/`HighlightStyleBar`（**仅内部按钮**）、`ReaderView` 顶栏、`LibraryView`、`SummaryPill` 按钮、`Sidebar`/`ReaderPrefs`/`ChipBar` action、`SettingsPanel` 按钮、`Composer` 发送 |
| **Tooltip**        | icon 按钮（`ReaderView` 顶栏等）、`Kbd` 辅助提示（按需）                                                                                                                                              |
| **Card**           | `LibraryView` 书卡、`AnnotationsList` 标注项（按需包装；非强制）                                                                                                                                      |

**本轮不做**（明确非目标）：

- 选区浮动工具栏（`SelectionToolbar`/`HighlightStyleBar`）的**定位/消失逻辑**——保留 RA3 调好的 iframe 感知实现（选区锚定、滚动/点外/iframe 内 mousedown 关闭），仅把内部色块/图标按钮换成 `Button` 原语。迁 Base UI Popover（virtual anchor）记入 ROADMAP 后续尝试。
- app 专属组合件的**结构重构**（消息气泡、面板布局）——保留现结构，仅其内部按钮/输入换原语。
- 颜色模式切换 UI（独立 backlog；token 的 `.dark` 已就位，组件自动适配）。

## 5. 测试与验收

- 每组迁移后 `pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿（渲染层无单测，靠 typecheck 守类型 + 主进程 192 测试不回归）。
- **手测 checkpoint**（渲染层行为靠真书手测，参照 RA3）：① Dialog 焦点陷阱/ESC/点外关闭 ② Popover 定位/ESC/点外关闭、不被 iframe 事件穿透 ③ Tabs 键盘切换 ④ 选区工具栏内部按钮替换后行为不回归（高亮即时套用、笔记 modal、删除）⑤ 动画进出场 ⑥ dark token 下观感。
- 视觉回归靠用户 checkpoint 确认（无快照测试基建）。

## 6. 执行方式

bite-sized 任务、按原语分组，每组（建原语 + 接入其消费方）独立提交 + 手测 checkpoint。基底/Button 先行，Dialog/Popover 等交互件随后（a11y 增益最大），Tooltip/Card 收尾。
