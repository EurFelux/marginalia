# 选择 AI action 后自动聚焦 AI panel 输入框设计

日期：2026-06-08
状态：待与用户对齐（2026-06-08 brainstorming），待实现
关联：GitHub issue #63（polish / area:ai）。需求「在选择任意 AI action 后，自动聚焦到 AI panel 输入框」。

## 1. 背景与动机

用户触发任一 AI action（选区工具栏的「AI 问 / 解释 / 翻译 / 概括」、侧栏打开已有会话、新对话按钮）后，绝大多数情况下紧接着就想在输入框打字（追问或直接 Enter 发预设提示语）。现状缺一次自动聚焦，逼用户多点一下输入框才能打字。

### 1.1 现状与缺口

`Composer.tsx` 现有聚焦逻辑（约 `:41-43`）：

```tsx
useEffect(() => {
  if (panelOpen) ref.current?.focus({ preventScroll: true });
}, [panelOpen]);
```

它**只在 `panelOpen` 由 false→true 时触发**。于是：

- panel 原本关闭 → 选 action 把它开开（false→true）→ effect 触发 → 聚焦 ✓
- panel **已开着** → 再选 action，`panelOpen` 仍是 true、值不变 → effect 不重跑 → **不聚焦** ✗

此外 `newConversation`（`AIPanel.tsx`）只调 `setActiveConversation`、**完全不碰 `panelOpen`**，故「新对话」按钮在任何情况下都不聚焦。`openConversation` 与选区 action 同理，仅在关→开时聚焦。

### 1.2 关键约束：关闭的面板是 `inert`，聚焦被浏览器吞掉

`CollapsiblePane` 是**单挂载点、开合不卸载**（注释见 `CollapsiblePane.tsx:46-49`，为保活 `useChat` 流式状态）——所以 `Composer` 与 textarea ref **永远有效**，不存在「ref 为 null」。

但 `CollapsiblePane.tsx:104` 在关闭时把面板子树设为 **`inert`**：

```tsx
<div inert={!open && !peekOpen} ... >
```

HTML 规范规定 **`inert` 子树内的元素无法被聚焦，`.focus()` 调用被忽略**。每个该聚焦的 action 同时会 `panelOpen=true`，但这只是**安排了一次重渲染**——`inert` 要等那次渲染 commit 后才摘掉。若在事件处理里 `updateLayout(open)` 后**同步**立即 `focus()`，此刻 `inert` 仍在 → 聚焦被吞。这正是原代码退而用 `useEffect`（跑在 commit 之后）的真实动机。

### 1.3 定性：聚焦是命令式动作，不该用 effect 模拟事件

原 effect 方案（含早期讨论过的「nonce 假事件」变体）本质是**把「用户选了 action」这个事件伪装成状态变化，再让 effect 侦测**——绕过 React 依赖比对。聚焦是「用户点击 → 立刻聚焦」的因果直连，应写在事件处理里命令式完成，而非「改状态 → 等渲染 → effect 回调」。本设计据此重做。

## 2. 设计目标

- 选择**任意** AI panel 入口后，输入框获得焦点：选区工具栏 action（`startAiAction`，含 null/explain/translate/summarize）、侧栏打开已有会话（`openConversation`）、新对话按钮（`newConversation`）。
- 覆盖「panel 已开着」与「panel 关→开」两种时序，均生效。
- 聚焦走**命令式**，不引入 effect 驱动聚焦（删掉现有 `useEffect([panelOpen])`）。
- **回归防护**：删掉 `useEffect([panelOpen])` 后，原本「任意 panel 开→聚焦」的覆盖面收窄；header 工具栏的开/合面板切换按钮（`ReaderView.tsx`）此前靠该 effect 在手动开面板时聚焦，故其「开」路径也接入 `openPanelAndFocusComposer()`（「关」仍 `updateLayout({ panelOpen: false })`），保留既有行为、避免回归。

**非目标**：`restoreConversation`（开书被动恢复上次会话）**不**纳入——用户未主动选 action，开书时抢焦点会从正文夺走光标，与其「不强制开面板」的既有语义一致。

## 3. 方案：`flushSync` 同步开面板 + 命令式聚焦句柄

### 3.1 命令式聚焦句柄（新模块 `src/renderer/ai/composer-focus.ts`）

三个调用方（`use-ai-actions` / `chat-store` / `AIPanel`）都不在 `Composer` 的 ref 传递链上，故用一个**模块级注册表**承载 Composer 暴露的命令式聚焦能力（`useImperativeHandle` 的精神，因调用方分散而改用模块单例）：

```ts
import { flushSync } from "react-dom";
import { usePrefsStore } from "@renderer/store/prefs-store";

let focusFn: (() => void) | null = null;

/** Composer 挂载时注册自身聚焦能力，卸载时传 null 注销。 */
export function registerComposerFocus(fn: (() => void) | null): void {
  focusFn = fn;
}

/** 命令式聚焦输入框（已注册时）；未注册为安全 no-op。 */
export function focusComposer(): void {
  focusFn?.();
}

/**
 * 开 AI 面板并聚焦输入框。flushSync 强制「开面板」那次渲染同步 commit、
 * 摘除 inert，随即命令式聚焦——绕开 inert 吞 focus 的时序坑（§1.2）。
 */
export function openPanelAndFocusComposer(): void {
  flushSync(() => usePrefsStore.getState().updateLayout({ panelOpen: true }));
  focusComposer();
}
```

无循环依赖：`composer-focus` 依赖 `prefs-store`；`Composer` / `use-ai-actions` / `chat-store` 依赖 `composer-focus`；`prefs-store` 不依赖任何一方。

### 3.2 `Composer.tsx`

- **删除** `useEffect([panelOpen])` 聚焦 effect 与不再使用的 `panelOpen` 订阅。
- 新增挂载期注册（这是「与外部注册表同步」的正当 effect，非事件模拟）：

```tsx
useEffect(() => {
  registerComposerFocus(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // 光标置末尾：预设提示语场景下用户可直接 Enter 或追加，符合直觉
    const end = el.value.length;
    el.setSelectionRange(end, end);
  });
  return () => registerComposerFocus(null);
}, []);
```

### 3.3 三个入口接线

| 入口               | 文件                | 改动                                                                                                                       |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `startAiAction`    | `use-ai-actions.ts` | 把 `updateLayout({panelOpen:true})` 换成 `openPanelAndFocusComposer()`                                                     |
| `openConversation` | `chat-store.ts`     | 同上（其后续 `set(openCommand...)` 不变；聚焦在 flushSync 后、load 历史不夺焦）                                            |
| `newConversation`  | `AIPanel.tsx`       | `setActiveConversation` 后调 `openPanelAndFocusComposer()`（面板必已开，flushSync 为近 no-op，统一走同一 helper 便于推理） |

## 4. 时序正确性

- **panel 关→开**（如关闭态选区「解释」）：`openPanelAndFocusComposer` 内 `flushSync(open)` 同步 commit → `inert` 摘除 → 紧接 `focusComposer()` 生效。
- **panel 已开**（如开着时再选「翻译」、或新对话）：`flushSync(open)` 近 no-op（已 true），`focusComposer()` 立即生效（非 inert）。
- `openConversation` 的 `set(openCommand)` 触发的历史载入只更新 `MessageList`、不重挂 textarea，焦点不丢。

## 5. 测试策略

- **单测**（headless，`composer-focus.test.ts`）：`registerComposerFocus(spy)` 后 `focusComposer()` 调用 spy；`registerComposerFocus(null)` 后 `focusComposer()` 为安全 no-op（不抛）。守住注册/注销契约（防有人忘了在 Composer 注册或漏 cleanup）。
- **不**单测 `openPanelAndFocusComposer`：`flushSync` + inert 摘除属真实 DOM 行为，headless（Electron node 运行时、无 DOM）无法验证。
- **dev CDP 冒烟**（本仓惯例）目视断言：① panel 关闭时选区「解释」→ 面板开 + 光标在输入框；② panel 已开时再「翻译」→ 焦点回到输入框；③ 新对话按钮 → 聚焦输入框；④ 开书恢复会话**不**抢焦点（回归保护非目标）。

## 6. 影响面

- 仅渲染层；无主进程、IPC、DB、迁移改动。
- 新增 1 个小模块 + 改 3 处入口 + 改 1 处 Composer。删除 1 个 effect。
- 用户向 changelog（changeset）：英文一条，「Auto-focus the AI panel input after triggering an AI action」。
