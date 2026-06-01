# Marginalia · UP1 UI 原型设计文档

> 状态：设计已确认，待落实施计划
> 日期：2026-06-01
> 上游：仓库根 `SPEC.md` 与 `docs/superpowers/specs/2026-05-31-marginalia-core-reading-loop-design.md`（§19 应用布局、§9 选区数据流、§7 分层上下文）。
> 轨道：**UI 原型轨**，在隔离的 `packages/ui-prototype/` 中独立开发；评审通过后再移植渲染层。

---

## 1. 目标与非目标

**目标**：在隔离的 `packages/ui-prototype/` 里把**选区 → 浮动工具栏 → AI 问 → chips → 模拟流式对话**这条核心阅读闭环做成**可点可玩的高保真界面/交互原型**，验证视觉与交互手感，评审后移植渲染层。

**指导原则（用户明确）**：**不引入多余复杂度，只看界面和交互**。一切"后端能力"用最简假实现，能演示即可，不追求架构保真或可移植机器。

**非目标（明确不做）**：

- Electron / IPC / preload / `window.api`
- 真 epub.js（加载、CFI、iframe 选区、自定义协议）
- 真 AI 调用 / Provider / 密钥
- 真持久化（无 DB、无 SQLite）
- 书库网格、Settings、Provider 配置、多 Assistant 管理
- AI SDK（`ai` / `@ai-sdk/react`）、`useChat`、UIMessage 保真建模
- 状态库（zustand 等）、token 估算镜像 main

---

## 2. 技术做法

- 复用现有脚手架：**TanStack Start 开启 SPA 模式**（`tanstackStart({ spa: { enabled: true } })`，应用内容纯客户端渲染、无 SSR——原型为纯前端 UI，SSR 只徒增水合不匹配；`<html>/<body>` 另加 `suppressHydrationWarning` 兜住浏览器扩展注入的属性）+ Tailwind 4 + shadcn(new-york / zinc) + lucide-react。
- 清掉模板 demo 内容，保留**单一主路由 `/`** 渲染三栏 `AppShell`。无第二路由（书库入口延后）。
- **运行时依赖**：i18next + react-i18next（UI 文案全走 key，对齐设计文档 i18next 选型；提供中 / 英 / 德三语，德语用来压布局）。状态用 React 自带能力：跨栏状态在 `AppShell` 提升 + 一个小 React context 共享；局部状态用 `useState`。
- ⚠️ 给原型装依赖须 `pnpm add --ignore-workspace`（原型被根 `pnpm-workspace.yaml` 排除，否则会装进根 + 两份 React 致 SSR 崩——见记忆 `ui-prototype-dep-install-gotcha`）。
- 消息、chip、book 等用**就手的本地 TS 类型**（不镜像 `shared/` 或 AI SDK 形状）。
- 全程**假数据 + 假"后端"**：fixtures 提供静态正文/TOC/示例会话；`useMockChat` 提供假流式。

---

## 3. 文件 / 组件结构

```
src/
├── routes/index.tsx               # 渲染 <AppShell/>（清空模板）
├── reader-ai-context.tsx          # React context + Provider：选区态、当前 chips、活动消息列表、
│                                  #   send()/stop()、面板折叠、本章摘要状态、阅读偏好
├── mock/
│   ├── fixtures.ts                # 假书(标题/作者) + 章节 + TOC + 各章静态正文(若干段) + 示例会话/消息
│   ├── useMockChat.ts             # 假流式：定时器逐段揭示 assistant 正文，可选先冒一张工具步骤卡；可 stop
│   └── types.ts                   # 本地类型：Book/Chapter/TocNode/Chip/ChatMessage/ToolStep/SummaryStatus
├── components/
│   ├── AppShell.tsx               # 三栏栅格 + 可折叠 AI 面板 + 主题切换挂载点
│   ├── ThemeToggle.tsx            # 亮/暗切换（写 <html> class）
│   ├── sidebar/
│   │   └── Sidebar.tsx            # 书库占位条目 + 当前书 TOC 导航树 + 会话列表(按书·章分组)
│   ├── reader/
│   │   ├── ReaderPane.tsx         # 静态正文渲染 + 阅读偏好内联控件(字号/行高/最大宽度)
│   │   ├── useSelection.ts        # 监听选区 → 取锚点块级元素 + 前1/后1段原始文本 + 选区矩形
│   │   └── SelectionToolbar.tsx   # 浮动工具栏：复制 / AI问 / 解释 / 翻译 / 概括
│   └── ai-panel/
│       ├── AIPanel.tsx            # 会话头(本章摘要状态 pill) + 消息列表 + 输入栏
│       ├── MessageList.tsx        # 渲染 ChatMessage[]：用户气泡 / 助手正文 / 折叠工具步骤卡 / 流式光标 / 错误内联
│       ├── ChipBar.tsx            # selection + paragraph chip：token 数、点击检视全文(popover)、toggle 位锁定(必备)
│       └── Composer.tsx           # textarea + 发送/停止按钮；预设动作会预填模板
└── components/ui/                 # shadcn 组件按需 add（button/scroll-area/popover/tooltip/badge 等）
```

> 仅 `useMockChat` 与 `mock/` 是"抛弃件"；展示型组件（Sidebar/Reader/AIPanel 各件）是原型产出的视觉/交互资产，移植渲染层时保留外观与交互、替换数据来源即可。

---

## 4. 本地数据类型（`mock/types.ts`）

```ts
type SummaryStatus = "pending" | "generating" | "ready" | "unavailable";

type TocNode = { id: string; label: string; children?: TocNode[] };
type Chapter = { id: string; title: string; paragraphs: string[]; summaryStatus: SummaryStatus };
type Book = { id: string; title: string; author: string; chapters: Chapter[]; toc: TocNode[] };

type Chip = {
  id: "selection" | "paragraph";
  labelKey: string; // 文案先写死中文，结构上预留 key
  content: string; // 原始文本
  tokenCount: number; // 粗估：Math.ceil(content.length / 3)
  required: boolean;
  enabled: boolean;
};

type ToolStep = { id: string; label: string; detail: string; status: "running" | "done" };

type ChatMessage =
  | { id: string; role: "user"; text: string; chips: Chip[] }
  | {
      id: string;
      role: "assistant";
      steps: ToolStep[];
      text: string;
      status: "streaming" | "done" | "error";
    };
```

---

## 5. 核心闭环交互（原型版数据流）

1. 在 `ReaderPane` 的**静态正文里真实划选**。`useSelection` 监听 `mouseup`/`selectionchange`，当选区落在阅读区内且非空：取选区 `Range` → 向上找最近块级元素（当前段）→ 读其前1/后1兄弟段 → 得 `{ selection, paragraph, rect }`。
2. 选区上方浮现 `SelectionToolbar`（定位用选区 `getBoundingClientRect`）：**复制 / AI问 / 解释 / 翻译 / 概括**。
3. 点任一 AI 动作 → AI 面板展开/聚焦 → 由 `selection`+`paragraph` 原文构建 `Chip[]`（token 用粗估）。预设（解释/翻译/概括）把对应**模板预填**进 `Composer`（可改可直接发）；「AI 问」留空待用户输入。
4. 用户可：点 chip 在 popover 里**检视全文**、编辑 textarea。`selection`/`paragraph` 在 Phase 1 **均为必备**（呼应设计文档 §7），ChipBar 显示其 token 数、提供检视，toggle 位**呈必备锁定态**（tooltip 说明本阶段必备）——预留未来可选 chip 的开关位。
5. 提交 → context 落一条 `user` 消息（带 chips 快照）→ `useMockChat` **渐进流式**出 `assistant` 消息：
   - 可选先 push 一张折叠的工具步骤卡（如「📖 读取《第 N 章》」`running` → 短暂后 `done`）；
   - 再用定时器**逐段揭示** `text`，末尾显示流式光标；
   - `Composer` 发送按钮在流式期间变**停止**，点击即 `stop()` 截断并标记 `done`。
6. 段落去重演示：若本轮 `paragraph` 与会话上一条相同，则本轮省略 paragraph chip（呼应设计文档 §6）。
7. **跨章选区 → 独立会话**：若一次选区跨越多个章节（`chapterIds.length > 1`），AI 面板切到**独立会话**态——标题「独立会话」、副标题列出跨越的章、提示条「已为跨章选择开启独立会话」、摘要指示改为 `跨章摘要 N/M`（best-effort 仅组合已 `ready` 章节）。**此为产品决策，权威定义见核心设计文档 §6「跨章选区」**；原型在此演示其 UI/UX。

---

## 标注与笔记（核心阅读功能）

阅读器核心功能（非 AI），与 AI 闭环并列（产品决策见核心设计文档「标注与笔记」节，已由 MVP 之外提入 Phase 1）：

- 选区浮动工具栏含 **5 色高亮** + 「笔记」。
- 高亮渲染进正文（可点）；点高亮 → 编辑卡（换色 / 写笔记 / 删除，点外部关闭）。
- 含笔记的高亮带 **✎** 标记 + 虚线下划。
- 侧栏「标注」标签页（目录 / 标注 / 会话 三页签）：全书高亮 + 笔记列表（色条 + 原文 + 笔记 + 章），点击跳回正文、可删。
- 跨段 / 跨章标注：一条标注含多段区间（选区按段拆字符偏移）。
- 种子数据预置 2 条标注（其一含笔记），首屏即可见。

---

## 6. 降级 / 错误态演示

- **本章摘要状态**：`AIPanel` 会话头放一枚状态 pill，可在 `pending`/`generating`/`ready`/`unavailable` 间切换演示；`unavailable` 时 tooltip 说明。
- **错误态**：提供一条触发路径（如某预设或开关），让 `useMockChat` 产出 `status: "error"` 的助手消息，**内联报错**、不当成功。
- **空态**：AI 面板未发起对话时显示引导空态（"划词后点 AI 问开始"）。

---

## 7. 主题 / 排版

- **亮/暗双主题**：`ThemeToggle` 切 `<html>` 的 `dark` class，走 shadcn CSS 变量（zinc 基色）。
- **阅读列优化**：`ReaderPane` 正文用衬线、舒适行高、受限最大宽度；内联小控件可调**字号 / 行高 / 最大宽度**（不进 Settings，仅原型内联演示阅读偏好手感）。

---

## 8. UP1 验收标准

- 三栏布局成型，AI 面板可折叠；亮/暗主题可切。
- 阅读区静态正文可真实划选 → 浮动工具栏出现且贴合选区。
- 「AI 问」+ 解释/翻译/概括 三个预设都通；预设能预填模板。
- ChipBar 显示 selection+paragraph（均必备）、各带 token 数；可点击检视全文，toggle 位呈必备锁定态；演示段落去重。
- 发送后模拟流式可跑（含一次折叠工具步骤卡）、可中途停止。
- 本章摘要 `pending/ready/unavailable` 与错误态、空态均可演示。
- 阅读偏好（字号/行高/宽度）经顶栏齿轮设置 popover 可调。
- 标注/笔记：划选可多色高亮 + 加笔记；点高亮可改色/改笔记/删除；侧栏「标注」页汇总+跳转；含笔记的高亮带 ✎ 标记。
- 摘要查看：章节摘要点 AI 面板 pill 弹卡看正文（未就绪显占位 + 演示切换）；全书概要点侧栏书卡看；跨章 pill 弹卡列各章摘要（best-effort）。
- i18n：顶栏语言菜单切中 / 英 / 德，UI 文案全走 key（正文/摘要等内容仍 fixtures）；切德语观察侧栏标签 / 摘要 pill / 按钮的布局响应性。
- 全程零真后端（无 Electron / epub.js / AI / DB）。

---

## 9. 移植说明（非本轨工作，仅备注）

原型评审通过后移植渲染层时：展示型组件保留；`reader-ai-context` 的 `send/stop/messages` 换成 §15 IPC 契约下的 `useChat` + 自定义 IPC transport；`useSelection` 的 DOM 取段逻辑可直接复用（renderer 唯一允许碰 DOM 处）；`mock/` 整体丢弃。

---

## 10. 后续 UP（预告，非本次范围）

- UP2：书库网格 + 导入入口流
- UP3：Settings（Provider 配置 / 默认 Assistant 编辑 / 阅读偏好）
- 移植轨：组件移植渲染层 + 接 §15 流式 IPC transport
