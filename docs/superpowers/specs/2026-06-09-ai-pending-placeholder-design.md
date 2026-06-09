# Marginalia · AI 面板 submitted 空窗占位气泡设计文档

> 状态：设计已确认（用户认可，待实现）
> 日期：2026-06-09
> 轨道：AI 会话 UX——发送 user 消息后到 assistant 气泡出现之间的空窗，补一个即时占位指示，消除"按下发送后一片空白"的卡顿观感。
> 需求：用户口头报告 2026-06-09（"user message 发出后要等好一会儿 assistant 才出来，希望首个 chunk 前先渲染占位"）。kanban issue 待补（polish · area:ai · area:ui）。

---

## 0. 问题陈述（取证结论）

渲染层用 AI SDK `useChat` + 自定义 IPC transport（`src/renderer/ai/ipc-chat-transport.ts`）。一轮发送的状态流为 `submitted`（已发送、首 chunk 未到）→ `streaming`（chunk 到达）→ `ready`/`error`。

`MessageList`（`src/renderer/ai/MessageList.tsx`）渲染：assistant 气泡在 `segs.length === 0 && !streaming` 时 **return null**（不渲染）；`streaming && !hasText` 时显示脉冲光标 `▍`（`MessageList.tsx:141-143`）。`streaming` 仅在 `status === "streaming"`（首 chunk 后）为真。

**空窗 = `submitted` 窗口**：此时 `messages` 末尾只有 user 气泡、尚无 assistant 消息，整段空白。`segments()`（`segments.ts:16-30`）把 `reasoning` part 整个过滤，故首 chunk 后即便只在 reasoning、`▍` 也已经显示——**唯一未覆盖的就是 `submitted` 这段**（TTFT / 不增量流式的整块 reasoning）。用户感知的"reasoning 期间空白"即此。

## 1. 目标与非目标

**目标**：`status === "submitted"` 时在 user 气泡下方即时渲染一个占位 assistant 气泡（脉冲 `▍`），与首 chunk 后的 streaming `▍` 无缝交接。

**非目标**：

- 不渲染 reasoning 内容（用户要的是占位，非思维流；YAGNI）。
- 不改主进程 / IPC / 流式协议。
- 不加 i18n（`▍` 非文案）。
- 不引入组件测试设施（渲染层无 RTL、vitest env=node、惯例只测纯逻辑）。

## 2. 设计

仅改 `src/renderer/ai/MessageList.tsx`（renderer-only）：

1. **抽共享 `ThinkingCursor`**：把现有 `<span className="inline-block animate-pulse text-primary">▍</span>`（`MessageList.tsx:142`）抽成一个极小组件，供「streaming 无文本」与「占位气泡」共用（DRY）。
2. **新增 `PendingBubble`**：与 `AssistantBubble` 同款外壳（`group flex flex-col items-start` + `max-w-[88%] … rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 …`），内仅一个 `<ThinkingCursor />`。
3. **挂载**：`MessageList` 消息列表后 `{status === "submitted" && <PendingBubble />}`。

**无缝 & 互斥**：`submitted` 显示占位 `▍`；首 chunk → `streaming`，真 assistant 气泡接管（仍 `▍` 直到出文本），占位因 `status !== "submitted"` 撤下。两状态互斥 → 任一时刻只有一个 `▍`，无双光标。

**边界**：新会话首发 `messages.length === 1`（非 0，不触发空提示分支）；`error`/`abort`/`ready` 均改 status，占位自然撤下。

## 3. 测试与验证

- 无可抽取的非平凡逻辑（条件即 `status === "submitted"`）；渲染层无组件测试设施，故**不造测试**，以真机冒烟为准：发送一条消息，确认按下即出现脉冲占位、首 chunk 后无缝过渡、收尾撤下；`error`/`abort` 路径占位不残留。
- `pnpm typecheck` + `pnpm lint` 绿。

## 4. 关联

- 改动文件：`src/renderer/ai/MessageList.tsx`。
- 既有 pattern：`MessageList.tsx:141-143` 的 streaming `▍`。
- 状态来源：`AIPanel.tsx` 的 `useChat().status`、`ipc-chat-transport.ts` 的状态流。
