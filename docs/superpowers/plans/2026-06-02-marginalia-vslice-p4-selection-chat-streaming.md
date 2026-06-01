# 竖切 Plan 4：S3 选区→chip→composer · S4 端到端真模型流式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已就绪的渲染层骨架（S1）、正文阅读（S2）、Anthropic 设置（S-prov）之上，落地竖切最后两块——S3「划选正文 → 浮动工具栏 → `ai.buildChips` → composer 出 chips + 草稿」与 S4「composer 提交 → `useChat` + 自定义 `IpcChatTransport` → 既有 `ai:send` 流式 transport → 消息列表逐字增量」，打通端到端「导入 → 读 → 选 → 问 → 真模型流式回复」。

**Architecture:** 主进程厚 / 渲染层薄硬性规则不变。**关键前提：M-a 流式 transport 主进程层已全部实现并 headless 测过**——`src/main/ipc/ai-handlers.ts`（`registerAiHandlers` + `pumpStream`，已在 `main.ts` 注册）、`src/main/ai/send-deps.ts`（`makeSendDeps`）、`src/main/ai/chips.ts`（`buildChips`，经 `chat-handlers.ts` 注册 `ai:build-chips`）、`src/main/ai/send.ts`（`runSend` 已接 `abortSignal`）、`src/shared/chat.ts`（`sendRequest`/`sendAck`/`abortInput`/`AiStreamEvent` 全部 schema）、`src/preload.ts`（`window.api.ai.buildChips/send/abort/onChunk` 全就绪）。**故 Plan 4 是纯渲染层工作**，不动主进程。渲染层移植 UP1 已评审的 AI 面板/选区交互视觉资产（`packages/ui-prototype/`），替换数据源为 `window.api` + `useChat` + zustand。

研究发现并对设计做一处收敛（记录在案，类比 Plan 3 的 `content.chapters` 补口）：**spec §4.6 让 transport 从 `useReaderStore.getState().draftChips` 读 chips**，但 Composer 发送后会同步清空 `draftChips`，与 transport 异步读 store 存在竞态（chips 可能在 transport 读到前已被清空）。本计划改为**让 chips 随「刚发出的那条用户消息」携带**（`useChat` 的 `sendMessage({ text, metadata: { contextChips } })`，transport 从 `messages.at(-1).metadata` 读取）——消息一经创建即不可变，无竞态，且仍满足 spec §4.1「本轮 userText + chips 同行上送」。稳定态（`bookId`/`currentChapterId`/`activeConversationId`）仍读 store。

**Tech Stack:** Electron 41.7.1（锁定）+ React 19 + `@ai-sdk/react` v6（`useChat`）+ `ai` v6（`ChatTransport`/`UIMessage`/`UIMessageChunk`）+ TanStack Query 5 + zustand 5 + Tailwind 4 + uuid v7 + vitest 4。

**ABI 提示（执行者必读）：** vitest 已跑在 **Electron 运行时**（`pnpm test` 经 `ELECTRON_RUN_AS_NODE=1 electron …`），与 `pnpm start` **同享 better-sqlite3 Electron ABI（145）**。故本计划**手测（`pnpm start`）与测试（`pnpm test`）之间无需任何 ABI 翻转 / rebuild**——这是 Plan 3 之后 `chore(test): run vitest under Electron runtime` 的成果。

**提交约定：** Conventional Commits；每个 commit 信息末尾附一行 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。全部 commit 留在分支 `feat/vslice-p1-ipc-transport`、并入 **PR #6**（整个竖切一个 PR）。

---

## 文件结构

**Part A — S4 流式骨架（先打通「打字即可端到端流式」，de-risk 最高风险项）：**

| 文件                                         | 责任                                                       | 改动   |
| -------------------------------------------- | ---------------------------------------------------------- | ------ |
| `src/renderer/ai/types.ts`                   | `ChatUIMessage` = `UIMessage<{contextChips?: Chip[]}>`     | Create |
| `src/renderer/ai/ipc-chat-transport.ts`      | `createEventStream`（纯·可测）+ `createIpcChatTransport`   | Create |
| `src/renderer/ai/ipc-chat-transport.test.ts` | chunk 流重组的 headless 单测                               | Create |
| `src/renderer/ai/ChipBar.tsx`                | composer 上方 chip 栏（移植 UP1，去 i18n/ScrollArea）      | Create |
| `src/renderer/ai/MessageList.tsx`            | 消息列表（从 `UIMessage.parts` 渲染，流式光标，tool 卡片） | Create |
| `src/renderer/ai/Composer.tsx`               | 输入框（读 store 草稿，Enter 发送，props 注入 send/stop）  | Create |
| `src/renderer/ai/AIPanel.tsx`                | `useChat` 接线 + 滚动 + 新对话 + 错误条                    | Create |
| `src/renderer/reader/ReaderView.tsx`         | 三栏布局 + 面板开合按钮                                    | Modify |

**Part B — S3 选区链：**

| 文件                                       | 责任                                            | 改动   |
| ------------------------------------------ | ----------------------------------------------- | ------ |
| `src/renderer/reader/useSelection.ts`      | 原生选区 → `SelectionInfo`（前/当/后段 + rect） | Create |
| `src/renderer/reader/ReaderPane.tsx`       | 段落标 `data-paragraph` + containerRef + 接选区 | Modify |
| `src/renderer/ai/use-ai-actions.ts`        | `startAiAction(preset)`：buildChips→草稿→开面板 | Create |
| `src/renderer/reader/SelectionToolbar.tsx` | 浮动工具栏（AI 问 + 3 preset，rect 定位）       | Create |
| `src/renderer/reader/ReaderView.tsx`       | 挂载 `<SelectionToolbar/>`                      | Modify |

> 渲染层 store（`reader-store`）字段已齐备（`selection`/`draftChips`/`draftText`/`panelOpen`/`activeConversationId` 及对应 setter），**无需改动**。

---

## Part A — S4 流式骨架

### Task 1: `IpcChatTransport` + `ChatUIMessage` 类型（含 headless 测试）

**Files:**

- Create: `src/renderer/ai/types.ts`
- Create: `src/renderer/ai/ipc-chat-transport.ts`
- Test: `src/renderer/ai/ipc-chat-transport.test.ts`

> `createEventStream` 把 `ai:chunk` 事件流（`AiStreamEvent`）重组为 `ReadableStream<UIMessageChunk>`——抽成纯函数（注入 `onChunk` 订阅器），不依赖 `window.api`/DOM，可 headless 单测（spec §9）。`createIpcChatTransport` 包它 + `ai.send` invoke + abort 接线（触碰 `window.api`，靠手测覆盖）。

- [ ] **Step 1: 写类型文件**

`src/renderer/ai/types.ts`：

```ts
import type { UIMessage } from "ai";
import type { Chip } from "@shared/chat";

/** 渲染层活跃对话 UIMessage 的元数据：随用户消息携带本轮上下文 chips（live 形态）。 */
export interface ChatMetadata {
  contextChips?: Chip[];
}

/** useChat / transport 全程使用的消息类型。 */
export type ChatUIMessage = UIMessage<ChatMetadata>;
```

- [ ] **Step 2: 写失败测试**

`src/renderer/ai/ipc-chat-transport.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import type { AiStreamEvent } from "@shared/chat";
import { createEventStream } from "@renderer/ai/ipc-chat-transport";

/** 假订阅器：捕获回调，返回受控的 emit + 退订标志。 */
function fakeOnChunk() {
  let cb: ((ev: AiStreamEvent) => void) | null = null;
  let unsubbed = false;
  const onChunk = (_streamId: string, _cb: (ev: AiStreamEvent) => void) => {
    cb = _cb;
    return () => {
      unsubbed = true;
    };
  };
  return {
    onChunk,
    emit: (ev: AiStreamEvent) => cb?.(ev),
    get unsubbed() {
      return unsubbed;
    },
  };
}

const textChunk = (delta: string): AiStreamEvent => ({
  streamId: "s1",
  type: "chunk",
  chunk: { type: "text-delta", id: "t1", delta } as UIMessageChunk,
});

describe("createEventStream", () => {
  it("enqueues chunks, closes on finish, and unsubscribes", async () => {
    const fake = fakeOnChunk();
    const stream = createEventStream("s1", fake.onChunk);
    const reader = stream.getReader();
    fake.emit(textChunk("Hello"));
    fake.emit(textChunk(" world"));
    fake.emit({ streamId: "s1", type: "finish" });
    expect(((await reader.read()).value as { delta: string }).delta).toBe("Hello");
    expect(((await reader.read()).value as { delta: string }).delta).toBe(" world");
    expect((await reader.read()).done).toBe(true);
    expect(fake.unsubbed).toBe(true);
  });

  it("errors the stream and unsubscribes on an error event", async () => {
    const fake = fakeOnChunk();
    const stream = createEventStream("s1", fake.onChunk);
    const reader = stream.getReader();
    fake.emit({ streamId: "s1", type: "error", message: "boom" });
    await expect(reader.read()).rejects.toThrow("boom");
    expect(fake.unsubbed).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/ipc-chat-transport.test.ts`
Expected: FAIL（`createEventStream` 模块不存在 / 未导出）。

- [ ] **Step 4: 实现 transport**

`src/renderer/ai/ipc-chat-transport.ts`：

```ts
import type { ChatTransport, UIMessageChunk } from "ai";
import { v7 as uuidv7 } from "uuid";
import type { AiStreamEvent } from "@shared/chat";
import { useReaderStore } from "@renderer/store/reader-store";
import type { ChatUIMessage } from "@renderer/ai/types";

/** onChunk 订阅器签名（与 window.api.ai.onChunk 一致；测试可注入假实现）。 */
type OnChunk = (streamId: string, cb: (ev: AiStreamEvent) => void) => () => void;

/**
 * 纯函数：把 ai:chunk 事件流重组为 ReadableStream<UIMessageChunk>。
 * chunk → enqueue；finish → close；error → error。任一收尾都退订。
 * 抽出以便 headless 单测（不碰 window.api / DOM）。
 */
export function createEventStream(
  streamId: string,
  onChunk: OnChunk,
): ReadableStream<UIMessageChunk> {
  let unsub: (() => void) | undefined;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      unsub = onChunk(streamId, (ev) => {
        if (ev.type === "chunk") controller.enqueue(ev.chunk);
        else if (ev.type === "finish") {
          controller.close();
          unsub?.();
        } else {
          controller.error(new Error(ev.message));
          unsub?.();
        }
      });
    },
    cancel() {
      unsub?.();
    },
  });
}

/** 末条用户消息的纯文本（拼接其全部 text parts）。 */
function lastUserText(messages: ChatUIMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  return last.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * 自定义 ChatTransport：经 IPC（ai:send / ai:abort / ai:chunk）对接主进程 runSend。
 * - 历史不上送（spec §4.1：主进程是会话历史唯一真源，从 DB 装配 prompt）。
 * - userText + chips 取自「刚发出的那条用户消息」（chips 在 metadata.contextChips），
 *   而非读 store.draftChips——避免与 Composer 发送后同步清空 draftChips 的竞态
 *   （见计划头 Architecture 收敛说明；仍满足 §4.1「userText + chips 同行」）。
 * - bookId / currentChapterId / activeConversationId 为稳定态，仍读 store。
 * - 先订阅 ai:chunk 再 invoke ai:send（spec §4.4：订阅必早于推送，无竞态）。
 */
export function createIpcChatTransport(): ChatTransport<ChatUIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const { currentBookId, currentChapterId, activeConversationId } = useReaderStore.getState();
      if (!currentBookId || !currentChapterId) {
        throw new Error("没有正在阅读的章节，无法发送。");
      }
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      const chips = last?.metadata?.contextChips ?? [];

      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      const ack = await window.api.ai.send({
        streamId,
        bookId: currentBookId,
        currentChapterId,
        activeConversationId,
        chips,
        userText,
      });
      if (!ack.ok) {
        void stream.cancel(); // 触发 cancel() → 退订，避免监听器泄漏
        throw new Error(ack.reason); // useChat 进 error 态
      }
      useReaderStore.getState().setActiveConversation(ack.conversationId); // ack 回写（组件外）
      return stream;
    },
    // 单窗口竖切不做断线重连。
    reconnectToStream: async () => null,
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/ipc-chat-transport.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 6: 全量测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全 PASS，无类型错误。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ai/types.ts src/renderer/ai/ipc-chat-transport.ts src/renderer/ai/ipc-chat-transport.test.ts
git commit -m "feat(renderer): add IpcChatTransport bridging useChat to ai:send IPC"
```

---

### Task 2: `ChipBar`（composer 上方 chip 栏）

**Files:**

- Create: `src/renderer/ai/ChipBar.tsx`

> 移植 UP1 `ChipBar`：每个 chip 一张小卡（label + token + 一行截断预览 + 必备锁），hover 上浮 portal 全文卡（视口夹取、向上生长）。去掉原型的 `react-i18next`（labelKey → 中文映射）与 `ScrollArea`（用 `max-h-40 overflow-y-auto` 类）。portal 浮层的 `left/bottom` 是运行时计算值——按 CLAUDE.md 允许内联 `style`。纯展示型，无 headless 单测（验收靠 typecheck/lint + 手测）。

- [ ] **Step 1: 写组件**

```tsx
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import type { Chip } from "@shared/chat";

const CHIP_LABEL: Record<string, string> = {
  "chip.selection": "选区",
  "chip.paragraph": "段落上下文",
};
const labelOf = (chip: Chip): string => CHIP_LABEL[chip.labelKey] ?? chip.labelKey;

interface HoverState {
  chip: Chip;
  rect: DOMRect;
}

export function ChipBar({ chips }: { chips: Chip[] }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHover(null), 160);
  };

  if (chips.length === 0) return null;

  return (
    <div className="flex gap-1.5">
      {chips.map((chip) => (
        <div
          key={chip.id}
          onMouseEnter={(e) => {
            cancelClose();
            setHover({ chip, rect: e.currentTarget.getBoundingClientRect() });
          }}
          onMouseLeave={scheduleClose}
          className="min-w-0 flex-1 cursor-default rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{labelOf(chip)}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              ≈{chip.tokenCount} tok
            </span>
            {chip.required && <Lock className="ml-auto size-3 shrink-0 text-muted-foreground/70" />}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{chip.content}</div>
        </div>
      ))}
      {hover && (
        <ChipPopover
          chip={hover.chip}
          rect={hover.rect}
          label={labelOf(hover.chip)}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </div>
  );
}

function ChipPopover({
  chip,
  rect,
  label,
  onEnter,
  onLeave,
}: {
  chip: Chip;
  rect: DOMRect;
  label: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  if (typeof document === "undefined") return null;
  const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 320 - 12);
  const bottom = window.innerHeight - rect.top + 8; // 底边贴卡片顶上方 8px，向上生长

  return createPortal(
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "fixed", left, bottom, zIndex: 60 }}
      className="max-h-40 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed shadow-xl"
    >
      <div className="mb-1 font-medium text-foreground">将发送 · {label}</div>
      <p className="whitespace-pre-wrap text-muted-foreground">{chip.content}</p>
      {chip.required && (
        <div className="mt-2 text-[11px] text-muted-foreground/70">
          必备上下文，随消息一并发送。
        </div>
      )}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/ChipBar.tsx
git commit -m "feat(renderer): add ChipBar for context chip preview"
```

---

### Task 3: `MessageList`（从 `UIMessage.parts` 渲染流式消息）

**Files:**

- Create: `src/renderer/ai/MessageList.tsx`

> 移植 UP1 `MessageList` 的气泡视觉，数据源换成 `useChat` 的 `ChatUIMessage[]`：文本由 `parts` 里 `type==="text"` 的 part 拼接；tool 调用（agent 读章工具）由 `type` 以 `tool-` 开头或 `dynamic-tool` 的 part 渲染为简卡；流式光标按 `status==="streaming"` 且为末条 assistant 消息显示。错误态在 AIPanel 顶层错误条统一展示（不做逐气泡错误）。用户气泡下方按 `metadata.contextChips` 显示紧凑 token 合计。纯展示型，无 headless 单测。

- [ ] **Step 1: 写组件**

```tsx
import type { ChatStatus } from "ai";
import { Paperclip, Sparkles } from "lucide-react";
import type { ChatUIMessage } from "@renderer/ai/types";

function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function MessageList({
  messages,
  status,
}: {
  messages: ChatUIMessage[];
  status: ChatStatus;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">划选正文后点「AI 问」，或直接在下方提问。</p>
      </div>
    );
  }
  const lastId = messages.at(-1)?.id;
  return (
    <div className="space-y-5">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} m={m} />
        ) : (
          <AssistantBubble key={m.id} m={m} streaming={status === "streaming" && m.id === lastId} />
        ),
      )}
    </div>
  );
}

function UserBubble({ m }: { m: ChatUIMessage }) {
  const chips = m.metadata?.contextChips ?? [];
  const total = chips.reduce((sum, c) => sum + c.tokenCount, 0);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
        {textOf(m)}
      </div>
      {chips.length > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          <Paperclip className="size-3" />≈{total} tok
        </span>
      )}
    </div>
  );
}

function AssistantBubble({ m, streaming }: { m: ChatUIMessage; streaming: boolean }) {
  const text = textOf(m);
  const toolParts = m.parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool");
  const showBubble = text !== "" || streaming;
  return (
    <div className="flex flex-col items-start gap-2">
      {toolParts.map((p, i) => (
        <ToolStepCard key={i} part={p} />
      ))}
      {showBubble && (
        <div className="max-w-[88%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed">
          <span className="whitespace-pre-wrap text-foreground">{text}</span>
          {streaming && <span className="ml-0.5 inline-block animate-pulse text-primary">▍</span>}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({ part }: { part: ChatUIMessage["parts"][number] }) {
  const p = part as { type: string; toolName?: string; state?: string };
  const name = p.type === "dynamic-tool" ? (p.toolName ?? "tool") : p.type.replace(/^tool-/, "");
  const done = p.state === "output-available";
  return (
    <div className="flex w-full max-w-[88%] items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs">
      <span>📖</span>
      <span className="font-medium text-foreground">{name}</span>
      <span className="ml-auto text-muted-foreground">{done ? "已读取" : "读取中…"}</span>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/MessageList.tsx
git commit -m "feat(renderer): add MessageList rendering UIMessage parts with streaming caret"
```

---

### Task 4: `Composer`（输入框）

**Files:**

- Create: `src/renderer/ai/Composer.tsx`

> 移植 UP1 `Composer`：草稿态读 `reader-store`（`draftText`/`draftChips`），上方挂 `ChipBar`，Enter 发送 / Shift+Enter 换行，流式时切「停止」按钮。发送/停止由 props 注入（AIPanel 的 `useChat` 持有）。**发送时把 `draftChips` 作为 chips 快照交给 `onSend`，随后同步清空草稿**——chips 由 onSend（`sendMessage` 的 message metadata）携带，故同步清空不影响 transport（见计划头 Architecture）。`userText` 经 `sendInputSchema` 要求非空，故空文本禁用发送（即便有 chips）。原型 shadcn `Button` 换成原生 `button`。面板可见时聚焦输入框（`preventScroll` 兜底）。纯展示型，无 headless 单测。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "ai";
import { ArrowUp, Square } from "lucide-react";
import type { Chip } from "@shared/chat";
import { useReaderStore } from "@renderer/store/reader-store";
import { ChipBar } from "@renderer/ai/ChipBar";

interface Props {
  status: ChatStatus;
  onSend: (text: string, chips: Chip[]) => void;
  onStop: () => void;
}

export function Composer({ status, onSend, onStop }: Props) {
  const draftText = useReaderStore((s) => s.draftText);
  const draftChips = useReaderStore((s) => s.draftChips);
  const setDraftText = useReaderStore((s) => s.setDraftText);
  const setDraftChips = useReaderStore((s) => s.setDraftChips);
  const panelOpen = useReaderStore((s) => s.panelOpen);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    if (panelOpen) ref.current?.focus({ preventScroll: true });
  }, [panelOpen]);

  const send = () => {
    const text = draftText.trim();
    if (!text || isStreaming) return;
    onSend(text, draftChips);
    setDraftText("");
    setDraftChips([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card/40 p-3">
      {draftChips.length > 0 && (
        <div className="mb-2">
          <ChipBar chips={draftChips} />
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
        <textarea
          ref={ref}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            aria-label="停止"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:opacity-90"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            onClick={send}
            disabled={draftText.trim() === ""}
            aria-label="发送"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/Composer.tsx
git commit -m "feat(renderer): add Composer wired to reader-store draft and chat send/stop"
```

---

### Task 5: `AIPanel`（`useChat` 接线）

**Files:**

- Create: `src/renderer/ai/AIPanel.tsx`

> AI 面板容器：`useChat<ChatUIMessage>({ transport })` 持有活跃流式对话；`messages` 喂 `MessageList`，`status`/`stop`/`sendMessage` 给 `Composer`。新消息/流式增量 → 滚到底。「+ 新对话」清空 `messages` 并把 `activeConversationId` 置 null（下次发送由 `routeConversation` 新建）。`useChat.error`（含 `ack.ok===false` 抛出的「未配模型」原因，spec §8）渲染为底部错误条 + 去设置提示。`onSend` 把 chips 作为 `metadata.contextChips` 随用户消息发出。transport 用 `useMemo` 稳定一份。纯展示/接线型，无 headless 单测。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { Plus, X } from "lucide-react";
import { useReaderStore } from "@renderer/store/reader-store";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";

export function AIPanel() {
  const transport = useMemo(() => createIpcChatTransport(), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat<ChatUIMessage>({
    transport,
  });
  const setActiveConversation = useReaderStore((s) => s.setActiveConversation);
  const setPanelOpen = useReaderStore((s) => s.setPanelOpen);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const newConversation = () => {
    setMessages([]);
    setActiveConversation(null);
  };

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold">AI 助手</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={newConversation}
            aria-label="新对话"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => setPanelOpen(false)}
            aria-label="关闭面板"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <MessageList messages={messages} status={status} />
      </div>

      {error && (
        <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          发送失败：{error.message}
          <span className="text-muted-foreground">
            （请确认已在「设置」配置 Anthropic API Key 与模型）
          </span>
        </div>
      )}

      <Composer
        status={status}
        onStop={stop}
        onSend={(text, chips) => void sendMessage({ text, metadata: { contextChips: chips } })}
      />
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/AIPanel.tsx
git commit -m "feat(renderer): add AIPanel wiring useChat with IpcChatTransport"
```

---

### Task 6: `ReaderView` 三栏布局 + 面板开合（S4 骨架收口）

**Files:**

- Modify: `src/renderer/reader/ReaderView.tsx`

> 在现有「左栏章节 + 主栏正文」右侧加第三栏 AIPanel；头部加面板开合按钮（`MessageSquare`）。`panelOpen`/`setPanelOpen` 取自 `reader-store`。**AIPanel 始终挂载、用 `hidden` 切换可见**（不是 `{panelOpen && …}` 条件挂载）——否则关面板再开会让 `useChat` 重挂、丢掉整段对话；`hidden`（display:none）让其状态在开合间存活、且不占布局。此步后**无选区也能端到端**：开面板 → 打字 → 发送 → 真模型流式（最高风险项先验证）。

- [ ] **Step 1: 改 `ReaderView.tsx`**

整体替换为（在原文件基础上新增 `AIPanel` import、`MessageSquare` import、`panelOpen`/`setPanelOpen` 订阅、头部开合按钮、右侧 AIPanel 栏）：

```tsx
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Settings } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { ChapterList } from "@renderer/reader/ChapterList";
import { ReaderPane } from "@renderer/reader/ReaderPane";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";
import { AIPanel } from "@renderer/ai/AIPanel";

export function ReaderView() {
  const bookId = useReaderStore((s) => s.currentBookId);
  const chapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);
  const backToLibrary = useReaderStore((s) => s.backToLibrary);
  const panelOpen = useReaderStore((s) => s.panelOpen);
  const setPanelOpen = useReaderStore((s) => s.setPanelOpen);
  const openSettings = useSettingsStore((s) => s.setOpen);

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 首章解析：开书时 currentChapterId 为 null，章节列表到位后回填首章。
  useEffect(() => {
    if (chapterId == null && chapters.data && chapters.data.length > 0) {
      setCurrentChapter(chapters.data[0].id);
    }
  }, [chapterId, chapters.data, setCurrentChapter]);

  if (!bookId) return null;

  const currentTitle = chapters.data?.find((c) => c.id === chapterId)?.title ?? null;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <button
          onClick={backToLibrary}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
          书库
        </button>
        <div className="flex items-center gap-1">
          <ReaderPrefs />
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            aria-label="AI 面板"
            className={cn(
              "rounded-md p-2 hover:bg-muted",
              panelOpen ? "text-primary" : "text-muted-foreground",
            )}
          >
            <MessageSquare className="size-4" />
          </button>
          <button
            onClick={() => openSettings(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            aria-label="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-border bg-muted/30">
          <ChapterList bookId={bookId} />
        </aside>
        <main className="min-w-0 flex-1">
          {chapterId ? (
            <ReaderPane bookId={bookId} chapterId={chapterId} title={currentTitle} />
          ) : (
            <p className="p-10 text-sm text-muted-foreground">
              {chapters.isPending ? "加载章节…" : "本书无可读章节。"}
            </p>
          )}
        </main>
        {/* 始终挂载，用 hidden 切换可见——保住 useChat 对话状态在开合间存活。 */}
        <aside className={cn("w-96 shrink-0 border-l border-border", !panelOpen && "hidden")}>
          <AIPanel />
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/ReaderView.tsx
git commit -m "feat(renderer): add AI panel column and toggle to ReaderView"
```

- [ ] **Step 4: 【手测检查点 · S4 骨架】**

> ⚠️ 由人执行。subagent 在此停下并提示。前置：已按 Plan 3 手测配好 Anthropic API Key + 模型。

```bash
pnpm start
```

验收：

- 进阅读视图，点头部 AI 图标 → 右侧弹出 AI 面板（空态提示）。
- 在输入框打字 → Enter → 用户气泡出现，助手气泡**逐字流式**增量；若模型用了读章工具，出现「📖 … 读取中/已读取」简卡。
- 流式中「发送」变「停止」，点停止可中断。
- 点「+」清空对话；点「×」关面板。
- **未配模型时**：发送后面板底部出现红色错误条，提示去设置——不静默、不编造。

---

## Part B — S3 选区链

### Task 7: `useSelection` + `ReaderPane` 段落标注

**Files:**

- Create: `src/renderer/reader/useSelection.ts`
- Modify: `src/renderer/reader/ReaderPane.tsx`

> 移植 UP1 `useSelection` 的 DOM 取段逻辑，**改产出渲染层 `SelectionInfo`**（`selectionText` + 前/当/后段 + `rect`，字段对齐 `@shared/chat` 的 `buildChipsInput` 与 `@renderer/types`）。`paragraphCurrent` 取选区首段~末段（支持跨段，多段以 `\n\n` 连）；`paragraphBefore/After` 取相邻段。`rect` 取 `range.getBoundingClientRect()` 供工具栏定位。`ReaderPane` 给每个 `<p>` 标 `data-paragraph`、给 `<article>` 挂 `containerRef`，并 `useSelection(containerRef, setSelection)`。选区检测依赖浏览器 `window.getSelection`/`Range`，vitest（Electron-as-node 无 DOM）不便 headless 测——按 spec §9「组件交互不强求 headless」，靠手测覆盖。

- [ ] **Step 1: 写 `useSelection.ts`**

```ts
// 在静态正文上用浏览器原生选区还原「渲染层选区提取」：选中文本 + 触及段落（含跨段）的
// 前1/当前/后1 段上下文 + 选区包围盒（供浮动工具栏定位）。映射为 @renderer/types 的 SelectionInfo。

import { useEffect, type RefObject } from "react";
import type { SelectionInfo } from "@renderer/types";

function paragraphOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return el?.closest("[data-paragraph]") ?? null;
}
function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

export function useSelection(
  containerRef: RefObject<HTMLElement | null>,
  onSelect: (info: SelectionInfo | null) => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const compute = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        onSelect(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        onSelect(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;

      const startPara = paragraphOf(range.startContainer);
      const endPara = paragraphOf(range.endContainer);
      const anchorPara = startPara ?? endPara;
      if (!anchorPara) {
        onSelect(null);
        return;
      }

      const all = Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph]"));
      const i1 = all.indexOf(startPara ?? anchorPara);
      const i2 = all.indexOf(endPara ?? anchorPara);
      const lo = Math.min(i1, i2);
      const hi = Math.max(i1, i2);

      const current = all
        .slice(lo, hi + 1)
        .map(textOf)
        .filter(Boolean)
        .join("\n\n");
      const before = lo > 0 ? textOf(all[lo - 1]) : "";
      const after = hi < all.length - 1 ? textOf(all[hi + 1]) : "";

      const r = range.getBoundingClientRect();
      onSelect({
        selectionText: text,
        paragraphBefore: before || null,
        paragraphCurrent: current,
        paragraphAfter: after || null,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      });
    };

    // mouseup 后选区才稳定，下一帧再算
    const onMouseUp = () => window.setTimeout(compute, 0);
    // 选区被清空（点别处）→ 通知清空
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) onSelect(null);
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [containerRef, onSelect]);
}
```

- [ ] **Step 2: 改 `ReaderPane.tsx`**

整体替换为（新增 `useRef` import、`useSelection` import、`setSelection` 订阅、`containerRef`、`<article ref>`、`<p data-paragraph data-pidx>`）：

```tsx
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSelection } from "@renderer/reader/useSelection";

interface Props {
  bookId: string;
  chapterId: string;
  title: string | null;
}

export function ReaderPane({ bookId, chapterId, title }: Props) {
  const prefs = useReaderStore((s) => s.prefs);
  const setSelection = useReaderStore((s) => s.setSelection);
  const containerRef = useRef<HTMLElement | null>(null);
  useSelection(containerRef, setSelection);

  const chapter = useQuery({
    queryKey: qk.chapter(bookId, chapterId),
    queryFn: () => window.api.content.chapterText({ bookId, chapterId }),
  });

  const paragraphs = (chapter.data?.text ?? "").split("\n").filter((p) => p.trim().length > 0);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <article
        ref={containerRef}
        className="mx-auto px-10 py-14 font-serif text-foreground/90"
        style={{
          maxWidth: prefs.maxWidth,
          fontSize: `${1.125 * prefs.fontScale}rem`,
          lineHeight: prefs.lineHeight,
        }}
      >
        {title && (
          <h2 className="mb-8 font-sans text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {title}
          </h2>
        )}
        {chapter.isPending && <p className="text-sm text-muted-foreground">加载正文…</p>}
        {chapter.isError && (
          <p className="text-sm text-destructive">
            章节读取失败：{(chapter.error as Error).message}
          </p>
        )}
        {chapter.data && paragraphs.length === 0 && (
          <p className="text-sm text-muted-foreground">（本章无正文）</p>
        )}
        {paragraphs.map((p, i) => (
          <p key={i} data-paragraph data-pidx={i} className="mb-6 text-justify">
            {p}
          </p>
        ))}
        {chapter.data?.hasMore && (
          <p className="mt-10 text-center font-sans text-xs text-muted-foreground">
            （本章较长，已显示前 {chapter.data.text.length} 字；章内完整分页见后续里程碑）
          </p>
        )}
      </article>
    </div>
  );
}
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/useSelection.ts src/renderer/reader/ReaderPane.tsx
git commit -m "feat(renderer): detect text selection in ReaderPane into reader-store"
```

---

### Task 8: `use-ai-actions` + `SelectionToolbar` + 挂载（S3 收口 / 端到端）

**Files:**

- Create: `src/renderer/ai/use-ai-actions.ts`
- Create: `src/renderer/reader/SelectionToolbar.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx`

> `startAiAction(preset)`：读 store 当前 `selection` → `window.api.ai.buildChips(...)` 取 chips → 写 `draftChips` + `draftText`（preset 预填一句中文问题；`null`=「AI 问」留空待用户输入）→ 开面板 → 清 `selection`（收起工具栏）。`SelectionToolbar` 读 store `selection`，按 `rect` 定位（fixed，视口夹取，选区上方），`onMouseDown` preventDefault 防止点击清空选区，按钮调 `startAiAction`。最后在 `ReaderView` 挂 `<SelectionToolbar/>`。

- [ ] **Step 1: 写 `use-ai-actions.ts`**

```ts
import { useCallback } from "react";
import { useReaderStore } from "@renderer/store/reader-store";

export type PresetId = "explain" | "translate" | "summarize";

const PRESET_PROMPT: Record<PresetId, string> = {
  explain: "请解释选中的这段内容。",
  translate: "请把选中的这段内容翻译成简体中文。",
  summarize: "请概括选中的这段内容。",
};

export function useAiActions() {
  const startAiAction = useCallback(async (preset: PresetId | null) => {
    const { selection, setDraftChips, setDraftText, setPanelOpen, setSelection } =
      useReaderStore.getState();
    if (!selection) return;
    const chips = await window.api.ai.buildChips({
      selection: selection.selectionText,
      paragraphBefore: selection.paragraphBefore,
      paragraphCurrent: selection.paragraphCurrent,
      paragraphAfter: selection.paragraphAfter,
    });
    setDraftChips(chips);
    setDraftText(preset ? PRESET_PROMPT[preset] : "");
    setPanelOpen(true);
    setSelection(null); // 收起工具栏
  }, []);

  return { startAiAction };
}
```

- [ ] **Step 2: 写 `SelectionToolbar.tsx`**

```tsx
import type { ReactNode } from "react";
import { BookOpen, FileText, Languages, Sparkles } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { useReaderStore } from "@renderer/store/reader-store";
import { useAiActions, type PresetId } from "@renderer/ai/use-ai-actions";

const PRESETS: { id: PresetId; label: string; icon: typeof BookOpen }[] = [
  { id: "explain", label: "解释", icon: BookOpen },
  { id: "translate", label: "翻译", icon: Languages },
  { id: "summarize", label: "概括", icon: FileText },
];

export function SelectionToolbar() {
  const selection = useReaderStore((s) => s.selection);
  const { startAiAction } = useAiActions();
  if (!selection || !selection.rect) return null;

  const { rect } = selection;
  const PAD = 200;
  const left = Math.min(Math.max(rect.x + rect.width / 2, PAD), window.innerWidth - PAD);
  const top = rect.y - 10;

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 50 }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn
        primary
        onClick={() => void startAiAction(null)}
        icon={<Sparkles className="size-3.5 text-primary" />}
        label="AI 问"
      />
      {PRESETS.map((p) => {
        const Icon = p.icon;
        return (
          <ToolBtn
            key={p.id}
            onClick={() => void startAiAction(p.id)}
            icon={<Icon className="size-3.5" />}
            label={p.label}
          />
        );
      })}
    </div>
  );
}

function ToolBtn({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-muted",
        primary && "text-primary",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 3: `ReaderView.tsx` 挂载 `<SelectionToolbar/>`**

在 Task 6 的 `ReaderView.tsx` 顶部 import 区追加：

```tsx
import { SelectionToolbar } from "@renderer/reader/SelectionToolbar";
```

并在根 `<div className="flex h-screen flex-col …">` 的**闭合 `</div>` 之前**（与 header / 内容 div 同级）追加一行：

```tsx
<SelectionToolbar />
```

即结构变为：

```tsx
  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header …>…</header>
      <div className="flex min-h-0 flex-1">…</div>
      <SelectionToolbar />
    </div>
  );
```

- [ ] **Step 4: typecheck + lint + 全量测试**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/ai/use-ai-actions.ts src/renderer/reader/SelectionToolbar.tsx src/renderer/reader/ReaderView.tsx
git commit -m "feat(renderer): add selection toolbar and buildChips action for S3"
```

- [ ] **Step 6: 【手测检查点 · S3 + S4 端到端】**

> ⚠️ 由人执行。前置：已配好 Anthropic API Key + 模型。

```bash
pnpm start
```

验收（spec §7.2 S3 + S4 端到端）：

- 进阅读视图，**鼠标划选正文一段** → 选区上方浮出工具栏（AI 问 / 解释 / 翻译 / 概括）。
- 点「解释」→ AI 面板自动打开，composer 上方出现 chips（选区 + 段落上下文，hover 看全文），草稿预填「请解释选中的这段内容。」。
- 直接 Enter → 用户气泡（下方紧凑 token 合计）→ 助手**逐字流式**回复，回答确实针对所选内容。
- 点「AI 问」则草稿留空、聚焦输入框，自行输入问题后发送。
- 点别处取消选区 → 工具栏消失。
- 至此**端到端**贯通：导入 → 读 → 选 → 问 → 真模型流式回复。

---

## 完成后

全部 8 任务过 + 两个手测检查点通过后：

- 派一个最终 code-review subagent 复查整轮渲染层改动（spec 合规 + 代码质量）。
- 用 superpowers:finishing-a-development-branch 收尾；本竖切（Plan 1–4）整体并入 **PR #6**。
- 竖切 spec 的端到端目标即告达成；后续转入 `renderer-track-decomposition` 的 RA1-full（epub.js/CFI）、RA3（标注核心化）等。

## 刻意推迟（不在本计划）

- **会话历史初值**（spec §4.1：重开会话用 `messages.list-by-conversation` 取历史映射为 `useChat` 初值）——竖切单会话现用空初值；`useChat` 不按 `activeConversationId` 重挂（避免流式中重挂丢消息），换书时随 `ReaderView` 自然重挂复位。会话列表/历史渲染留后续。
- **章节摘要 pill / 跨章会话标识 / CombinedSummary**（UP1 `AIPanel` 头部的摘要弹卡、跨章作用域提示）——竖切 AI 面板头部从简。
- **chip toggle（`required`/`enabled` 闭合）**（`chipSchema` 的 MA5 TODO）——竖切复用既有 chip，全为必备、不可切。
- **复制 / 标注高亮 / 笔记按钮**（UP1 工具栏的非 AI 项）——标注已核心化但出本竖切（见 `annotations-core-decision` 记忆 / RA3）。
- **tool step 详情展开**（UP1 `ToolStepCard` 的折叠 detail）——竖切 tool 卡仅显示名称 + 状态。
- **字符级选区区间 / CFI 锚定 / 章内完整分页**——留 RA1-full（`useSelection` 暂不产出 `ranges`）。
