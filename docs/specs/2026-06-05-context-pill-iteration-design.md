# AI Panel 上下文 Pill 体系迭代设计

日期：2026-06-05
状态：已与用户对齐，待实现
前置：`2026-06-05-conversation-chapter-decoupling-design.md`（已交付合入 main）

## 1. 背景与动机

会话-章节解耦交付后，AI 面板的上下文 UI 留有五处体验毛刺（用户反馈）：

1. 章节摘要 pill（查看/生成弹卡）藏在 AI 面板 header——面板关着看不到摘要状态；
2. 摘要 toggle chip（`SummaryChipToggles`）无法预览内容，用户不知道「开了会发什么」；
3. 摘要缺失（未生成/失败）时 toggle 与可用态视觉无区分；
4. 选区与段落是同进同退的必备上下文，却显示为两个独立卡片（`ChipBar`），徒占空间；
5. 选区+段落一旦划词进入 draft 就无法移除——用户没有发送前反悔的手段。

另有技术债顺手清理：`ChipBar` 的自绘 hover 卡片（ROADMAP 延后项「ChipBar 迁 Base UI PreviewCard」）。

## 2. 决策摘要

| 决策点             | 结论                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| 组件架构           | **统一 `ContextPillBar`**——合并 `SummaryChipToggles` 与 `ChipBar` 的 Composer 职责，一套 pill 交互语言 |
| 章节摘要 pill 位置 | 阅读器顶栏**面包屑之后**（与章节名同区，`sm` 以下随面包屑隐藏）                                        |
| 选区+段落合并形态  | **统称单 pill**「选区上下文」，hover 卡内分「选中文本」「周围上下文」两段                              |
| pill 交互语义      | 摘要 pill = **开关**（点击 on/off）；选区 pill = **删除**（点 × 整体移除选区+段落）                    |
| 缺失摘要视觉       | **虚线 border** + muted 文字（pending/unavailable 态）                                                 |
| hover 预览         | 全部 pill 统一 shadcn **hover-card**（Base UI PreviewCard）；`ChipBar` 自绘 popover 退役               |
| chip 三态语义      | `buildChips` 构建值 `"required"` → **`"on"`**；`"required"` 保留仅用于历史水合（不可交互）             |

## 3. 顶栏迁移（SummaryPill）

- `<SummaryPill />` 从 `AIPanel` header 移到 `ReaderView` 顶栏左区、面包屑（「书名 · 章节名」）之后；与面包屑共用 `hidden sm:flex` 响应式（小窗一起隐藏）。
- query 门控从 `enabled: panelOpen && …` 改为 `enabled: !!bookId && !!chapterId`（常驻顶栏，不再依赖面板开合）；`usePrefsStore` 的 `panelOpen` 读取随之移除。
- 弹卡行为不变（查看正文 / 生成 / 重新生成 / force 语义）。
- `AIPanel` header 剩：标题 + 活跃会话标题副行 + 新对话「+」 + 关闭。

## 4. ContextPillBar（Composer 上方单行）

新组件 `src/renderer/ai/ContextPillBar.tsx` 替代 `SummaryChipToggles`（退役删除）与 `ChipBar`（退役删除），渲染单行：

```
[📄 章节摘要] [📚 全书摘要] [✂️ 选区上下文 ≈86 tok ×]
```

### 基件 ContextPill

统一 pill 样式（rounded-full + border + text-[11px]，沿用现 toggle pill 视觉），三种视觉态：

- **实线亮**（on）：`border-primary/40 bg-primary/10 text-foreground`
- **实线灰**（off）：`border-border bg-muted/40 text-muted-foreground`
- **虚线缺失**（摘要 pending/unavailable）：`border-dashed` + muted 文字——与 off 的区别是 border 样式，亮灰仍由 on/off 决定

左 slot 图标（generating 时换 `Loader2` spinner）、文字、右 slot 动作（删除 pill 的 ×；toggle pill 无）。

### 摘要 pill（章节/全书）

- 行为**全部不变**：点击开关；「将开启新会话」预亮；发送物化回落、未 ready 跳过保持 on；手动点亮 pending/unavailable 触发生成（主进程 inFlight 幂等兜底）。
- 章节摘要 pill 仅 `chapterId` 存在时渲染；全书摘要恒在（`bookId` 守卫在 bar 层）。

### 选区 pill

- 仅 draftChips 含 selection/paragraph chip 时出现；显示合计 token（selection+paragraph 之和）。
- 点 × **整体删除**：从 `draftChips` 移除 selection 与 paragraph 两个 chip（一次反悔动作）；重新划词照常重建。
- 无开关态——删了就没了。

## 5. Hover Card（统一预览）

- 新增 `src/renderer/components/ui/hover-card.tsx`：`pnpx shadcn add hover-card`（Base UI PreviewCard 包装；项目为 base-nova style，勿跑 init；加完检查是否需补装依赖 + `pnpm db:rebuild:electron`）。
- 所有 ContextPill 包 HoverCard：
  - **摘要 pill**：ready → 摘要正文（`ScrollArea` 限高，沿用 ChipBar 旧卡 `max-h-40` 取向）；pending →「尚未生成，点击生成」；generating →「生成中…」；unavailable →「生成失败，点击重试」。
  - **选区 pill**：「选中文本」「周围上下文」两段，各带内容与 token 数。
- `ChipBar` 自绘 portal popover（计时桥/手动定位）随组件退役——清 ROADMAP 延后项。

## 6. chip 三态语义微调

- `src/main/ai/chips.ts` `buildChips` 构建值 `state: "required"` → `state: "on"`——「锁定不可删」语义随删除能力失效。
- 三态枚举**保留**：`"required"` 仅由历史水合（`message-history.ts` `hydrateChip`）产出，表示「落库即已发送、不可交互」；`"on"/"off"` 为 live 态。
- `ai.chip.requiredContext`（「必备上下文，随消息一并发送。」）文案随 ChipBar 退役删除（i18n extract 收口）；Lock 图标随之消失。
- send 链不变：主进程 `state !== "off"` 防御过滤对 `"on"` 照发，行为零变化。

## 7. 影响面清单

| 层       | 文件                                 | 变更                                                                                       |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| renderer | `reader/ReaderView.tsx`              | 面包屑后挂 `<SummaryPill />`                                                               |
| renderer | `ai/SummaryPill.tsx`                 | 门控改 bookId/chapterId；删 panelOpen 依赖                                                 |
| renderer | `ai/AIPanel.tsx`                     | header 移除 SummaryPill                                                                    |
| renderer | `ai/ContextPillBar.tsx`（新）        | 统一 pill bar（含 ContextPill 基件）                                                       |
| renderer | `ai/SummaryChipToggles.tsx`          | **退役删除**（逻辑并入 ContextPillBar）                                                    |
| renderer | `ai/ChipBar.tsx`                     | **退役删除**                                                                               |
| renderer | `ai/Composer.tsx`                    | 渲染 ContextPillBar；onSend 物化逻辑不变；新增「删除选区上下文」回调（setDraftChips 过滤） |
| renderer | `components/ui/hover-card.tsx`（新） | shadcn hover-card（Base UI PreviewCard）                                                   |
| 主进程   | `ai/chips.ts`                        | buildChips 构建值 `"on"`                                                                   |
| 测试     | `chips.test.ts`、相关断言            | `"required"` → `"on"` 同步                                                                 |
| i18n     | locales                              | 删 `ai.chip.requiredContext`；hover 占位新 key（extract 收口）                             |

## 8. 测试与验证

- `summary-chips.ts` 物化纯函数、chat-store 状态机、transport、主进程 send 链**全部不动**（除 buildChips 一行）——纯 renderer 展示层迭代。
- chips.test.ts 构建断言同步 `"on"`；确认 send 链对 `"on"` chips 照发的既有测试仍绿。
- 组件手测为主（项目惯例）+ 真启动冒烟：顶栏 pill 弹卡、toggle 开关、虚线态、hover 预览、选区 pill 删除后发送不带选区。

## 9. 非目标

- 不动摘要生成机制与 toggle 状态机逻辑。
- 不做选区/段落分别删除（整体删，YAGNI）。
- 不动 MessageList 历史气泡的 chip 徽标渲染。
- 选区工具栏本身（划词浮条）不在本次范围。
