# 工具步骤内联渲染设计（#31）

- 日期：2026-06-07
- Issue：[#31 Render tool-call steps inside the assistant bubble](https://github.com/EurFelux/marginalia/issues/31)
- 范围：纯渲染层（`src/renderer/ai/`），零主进程改动

## 1. 背景与问题

工具步骤（readPage / readChapterText 等的 loading/done/failed 卡片）目前堆叠在 assistant 气泡**上方**（`MessageList.tsx` 的 `AssistantBubble` 把 tool parts 过滤出来、text parts 拼接渲染）——`m.parts` 中的交错出现顺序在数据层完好，仅在渲染时被破坏。多步调用时卡片成串占行，且与回复正文脱节。

UX 探索结论（2026-06-07 与用户确认）：

- **终端用户不关心 args/result 原始数据**——展开详情功能整个砍掉（先前讨论的行内展开/popover 均否决）。
- 取而代之：**把"人话"提进步骤行标题**（「读取第 12 页」而非「readPage」），用户扫一眼即知 AI 在干什么。
- 步骤行内联进气泡、按出现顺序与正文交错，紧凑单行、不可展开。

## 2. 目标与非目标

**目标**

1. 工具步骤按 `m.parts` 出现顺序内联渲染在 assistant 气泡内部，与文本段交错。
2. 步骤行显示带参数的人话标题 + 状态（读取中… / 完成 / 失败）。
3. 失败识别覆盖软失败：主进程 `runTool`（`tools.ts`）刻意把工具错误转成 `{ error }` 正常 result 供模型自我纠正，因此 `state === "output-error"` 几乎不触发——失败判定必须同时识别 result 的 `{ error }` 形状。
4. 顺手类型化 tool part，削掉现有手写 cast（#46 的一角）。
5. 历史消息同样生效（parts 已持久化并完整水合，无需主进程改动）。

**非目标（YAGNI）**

- 展开查看 args/result 详情（已与用户确认砍掉）。
- readPage image 模式的缩略图渲染。
- 多步骤分组/折叠容器。
- #42（prompt 组装侧的 tool parts 回放）——那是模型侧，本设计只管展示侧。
- 主进程任何改动。

## 3. UX 行为规格

```
┌─ assistant bubble ─────────────────┐
│ ▣ 读取目录 · 完成                  │
│ ▣ 读取第 12 页 · 完成              │
│ ▣ 读取章节文本 · 失败              │   ← 软失败照实标红（章节解析不到时标题同步回退）
│ ▣ 读取〈Preface〉· 完成            │   ← 模型自我纠正后的重试
│                                    │
│ 这一章主要讲了……（正文 markdown）│
└────────────────────────────────────┘
```

- 步骤行**始终单行紧凑**、无点击交互；流式期间状态原位从「读取中…」变为「完成/失败」，无布局跳动。
- 失败行照实显示（destructive 色）：模型通常会换参重试，失败行后跟成功行，透明呈现自我纠正过程。
- 图标：lucide 图标按工具映射（替换现 emoji 📖），与整体 UI 一致。
- 气泡显示条件更新为 `text 非空 || streaming || 有 tool 段`（现状是只看 text/streaming；改后有 tool 无 text 时气泡也成立）。

## 4. 组件与数据流

```
AIPanel ──bookId──▶ MessageList ──▶ AssistantBubble
                                       ├─ segments(m.parts)   纯函数归并
                                       └─ 顺序渲染：
                                          ├─ text 段 → LocalizedStreamdown
                                          └─ tool 段 → ToolStepRow
```

### 4.1 `segments()`（纯函数，单测覆盖）

`m.parts` → `Array<{ kind: "text"; text: string } | { kind: "tool"; part: ToolPart }>`：

- **连续 text part 合并**为一段（避免 markdown 跨段版式断裂）；
- tool part（`tool-*` 与 `dynamic-tool`）各自独立成段；
- 其余 part（`step-start` 等）过滤。

### 4.2 `ToolStepRow`（替换 `ToolStepCard`）

紧凑行：lucide 图标 + 人话标题 + 状态后缀。样式融入气泡（去掉现有 border 卡片感），`text-xs` muted 基调，失败态 destructive。

### 4.3 `toolStepLabel()`（新文件 `tool-step-label.ts`，纯函数，单测覆盖）

| 工具                | 标题                | 参数来源                   |
| ------------------- | ------------------- | -------------------------- |
| `readPage`          | 读取第 12 页        | `input.page`               |
| `readChapterText`   | 读取〈Preface〉     | `input.chapterId` → 章节名 |
| `getChapterSummary` | 读取〈Preface〉摘要 | 同上                       |
| `getToc`            | 读取目录            | —                          |
| 未知 / dynamic-tool | 原始 toolName       | 兜底                       |

章节名解析：

- 数据源 = `qk.chapters(bookId)` 的 React Query 缓存（章节列表 id+title 静态数据，staleTime ∞ 无碍；`ChapterList`/`ReaderView` 已在用同 key）。
- **宽容匹配**与主进程 `resolveChapterRef` 对齐：id 精确 → href → 标题（大小写不敏感）。模型传给 input 的是原始引用（uuid/href/标题都可能），主进程规范化结果不会回写 input，故渲染层必须自行宽容匹配。
- 任何一级解析不到 → 回退通用标题「读取章节文本」，绝不抛错。
- 参数注入文案走 i18next interpolation（`ai.toolStep.readPage` =「读取第 {{page}} 页」等）。

### 4.4 状态判定

```
failed = state === "output-error" || isErrorShape(output)   // { error: string }
done   = state === "output-available" && !failed
loading = 其余（input-streaming / input-available …）
```

`isErrorShape()` 与 `toolStepLabel()` 同文件，纯函数单测。

### 4.5 类型化

用 AI SDK v6 的 tool part 辅助（`isToolUIPart` / `getToolName`，实现时以 `ai` 包实际导出为准）替换现有 `as { type: string; toolName?; state? }` 手写 cast；`dynamic-tool` 分支单独收窄。

## 5. 错误处理

| 情形                             | 行为                                            |
| -------------------------------- | ----------------------------------------------- |
| 工具软失败（`{ error }` result） | 步骤行标失败，不影响后续段渲染                  |
| 章节引用解析不到                 | 回退通用标题，无日志噪音（属正常路径）          |
| chapters 缓存未就绪（极短暂）    | 同上回退；缓存到位后 React Query 重渲染自然纠正 |
| 未知 part 形状                   | `segments()` 过滤，不渲染不报错                 |

## 6. 测试策略

沿项目惯例：逻辑进纯函数，组件保持薄（渲染层既有测试均为纯函数测试，如 `chip-label.test.ts`）。

1. `segments.test.ts`：交错顺序保持、连续 text 合并、step-start/未知 part 过滤、空 parts。
2. `tool-step-label.test.ts`：四个工具的标题与参数注入、章节宽容匹配三级回退、未知工具兜底、`isErrorShape` 判定（`{ error }`、非对象、null、无 error 键）。
3. 收尾 Playwright CDP 冒烟（真流式）：步骤行内联交错出现、状态原位变迁、失败行标红。

React Compiler 已启用：不手写 memo；流式中 part 对象引用更新驱动重渲染，无需额外处理。

## 7. i18n

- 新增 key：`ai.toolStep.readPage`、`ai.toolStep.readChapterText`、`ai.toolStep.readChapterFallback`、`ai.toolStep.getChapterSummary`、`ai.toolStep.getToc`、状态后缀沿用现有 `ai.toolStep.{loading,done,failed}` key，其中 `done` 文案由「已读取」改为「完成」（人话标题已含「读取」动词，避免重复）。
- 注意 i18n 工作流坑：`pnpm i18n:extract` 先于 typecheck 跑；改键结构警惕 extract 用旧 fallback 反向覆盖 locale。

## 8. 交付物清单

- 改：`src/renderer/ai/MessageList.tsx`（AssistantBubble 重构、ToolStepRow、bookId prop）
- 改：`src/renderer/ai/AIPanel.tsx`（传 bookId）
- 新：`src/renderer/ai/segments.ts` + 测试
- 新：`src/renderer/ai/tool-step-label.ts` + 测试
- 改：locale 文件（新 key）
- 关联 issue：closes #31；#46 部分推进（tool part 类型化）
