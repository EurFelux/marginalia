# Conversation Deletion Implementation Plan (#30)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏会话列表支持删除会话（右键菜单 + hover 垃圾桶，确认对话框），级联删消息；删除活跃会话回落到「新会话空状态」；删除正在流式输出的会话时中止在跑流。

**Architecture:** 完全镜像 library 删书三件套（ContextMenu + AlertDialog + mutation 缓存清理）。主进程新增 `deleteConversation` 纯函数（DB FK 已级联删 messages）+ `conversations:delete` IPC；`ai-handlers.ts` 的流注册表扩展为 `streamId → {controller, conversationId}`，删除 binding 先按会话 abort 在跑流再删行；`runSend.onFinish` 增加会话存在 guard 防 abort 后落库撞 FK。

**Tech Stack:** Drizzle + better-sqlite3（FK cascade）、Zod IPC 契约、React 19 + TanStack Query + zustand、shadcn(Base UI) ContextMenu/AlertDialog、i18next、vitest（Electron 运行时）。

**背景（来自 issue #30 评论的 pre-implementation analysis）：**

- `messages.conversationId` FK 已 `onDelete: "cascade"`（`src/main/db/schema.ts`）——主进程只需删 conversations 一行。
- auto-naming race 已天然免疫：`nameConversation`（`src/main/chat/conversation-title.ts`）写回前复查 `row && row.title == null`，行已删 → `row` 为 `undefined` → 跳过；`namingInFlight` 有 `finally` 清除，无残留。
- UI 形态已由用户拍板（2026-06-07）：**右键菜单 + hover 垃圾桶并存**，汇入同一确认对话框。
- 删除活跃会话 → `setActiveConversation(null)` + `setSummaryChipsPreset()`（镜像「开书无会话」分支的新会话空状态）；AIPanel 既有 effect（`activeConversationId === null → setMessages([])`）负责清面板。**不**自动切到最近会话（issue 正文定的是 fall back to new-conversation empty state）。

**两个天然 TDD 红灯（项目漂移测试）：**

- `src/main/ipc/bindings-coverage.test.ts`：新增 invoke 契约但无 binding → 红。
- `src/preload-api.test.ts`：新增 invoke 契约但 preload 不暴露 → 红。

---

### Task 1: 主进程 `deleteConversation` 纯函数（TDD）

**Files:**

- Modify: `src/main/chat/conversations.ts`
- Test: `src/main/chat/conversations.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/chat/conversations.test.ts` 末尾追加（`messages` 需加入文件顶部既有的 `@main/db/schema` import；`deleteConversation` 加入既有的 `@main/chat/conversations` import）：

```ts
describe("deleteConversation", () => {
  it("removes the conversation and cascades its messages", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const convo = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    deleteConversation(db, convo.id);
    expect(getConversation(db, convo.id)).toBeNull();
    const remaining = db.select().from(messages).where(eq(messages.conversationId, convo.id)).all();
    expect(remaining).toEqual([]);
  });

  it("is idempotent: deleting an unknown id does not throw", () => {
    const db = freshDb();
    expect(() => deleteConversation(db, "nope")).not.toThrow();
  });

  it("does not touch other conversations of the same book", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const a = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const b = createConversation(db, { bookId: "book-1" });
    deleteConversation(db, a.id);
    expect(getConversation(db, b.id)?.id).toBe(b.id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: FAIL —— `deleteConversation is not a function`（或 import 报错）

- [ ] **Step 3: 最小实现**

在 `src/main/chat/conversations.ts` 的 `setConversationTitle` 之后加：

```ts
/** 删除会话（messages 由 FK 级联删）；幂等——未知 id 为 0-row delete。 */
export function deleteConversation(db: DB, id: string): void {
  db.delete(conversations).where(eq(conversations.id, id)).run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: PASS（全部既有 + 3 条新增）

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/conversations.ts src/main/chat/conversations.test.ts
git commit -m "feat(chat): add deleteConversation with cascading messages"
```

---

### Task 2: 在跑流注册表 + `abortConversationStreams`（TDD）

**Files:**

- Modify: `src/main/ipc/ai-handlers.ts`
- Test: `src/main/ipc/ai-handlers.test.ts`

**为什么：** 删除正在流式输出的会话时，主进程的流会继续推 chunk / 落库。renderer 侧拿不到 streamId（锁在 transport 闭包里），所以由主进程按 conversationId 维度 abort。`controllers: Map<string, AbortController>` 扩展为带 conversationId 的注册表。消费方是 Task 4 的 delete binding（同计划内，非 speculative）。

- [ ] **Step 1: 写失败测试**

在 `src/main/ipc/ai-handlers.test.ts` 追加（`beforeEach` 加入 vitest import；新函数加入 `@main/ipc/ai-handlers` import）：

```ts
describe("abortConversationStreams", () => {
  beforeEach(() => __resetStreams());

  it("aborts only the streams that belong to the conversation", () => {
    const a = new AbortController();
    const b = new AbortController();
    __registerStream("s1", "conv-1", a);
    __registerStream("s2", "conv-2", b);
    abortConversationStreams("conv-1");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("is a no-op when the conversation has no running stream", () => {
    expect(() => abortConversationStreams("conv-x")).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ipc/ai-handlers.test.ts`
Expected: FAIL —— `__resetStreams is not a function`（或 import 报错）

- [ ] **Step 3: 实现注册表**

在 `src/main/ipc/ai-handlers.ts` 中，将 `const controllers = new Map<string, AbortController>();` 整体替换为：

```ts
/** 在跑流注册表：streamId → abort 控制器 + 所属会话（conversation deletion 按会话中止用）。 */
const activeStreams = new Map<string, { controller: AbortController; conversationId: string }>();

/** 中止某会话的全部在跑流（conversations:delete 的前置步骤——防止删行后继续推送/落库）。 */
export function abortConversationStreams(conversationId: string): void {
  for (const s of activeStreams.values()) {
    if (s.conversationId === conversationId) s.controller.abort();
  }
}

/** 仅供测试：注册一条在跑流。 */
export function __registerStream(
  streamId: string,
  conversationId: string,
  controller: AbortController,
): void {
  activeStreams.set(streamId, { controller, conversationId });
}

/** 仅供测试：清空在跑流注册表。 */
export function __resetStreams(): void {
  activeStreams.clear();
}
```

`aiBindings` 中同步改引用（`req.conversationId` 即流所属会话——runSend 只校验不分配，`result.conversationId === input.conversationId`）：

```ts
export const aiBindings: Binding[] = [
  bind(C.aiSend, (req, event: IpcMainInvokeEvent): SendAck => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    activeStreams.set(streamId, { controller, conversationId: input.conversationId });

    const result = runSend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      activeStreams.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      activeStreams.delete(streamId);
    });
    return { ok: true, conversationId: result.conversationId };
  }),

  bind(C.aiAbort, ({ streamId }) => {
    activeStreams.get(streamId)?.controller.abort();
  }),
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ipc/ai-handlers.test.ts`
Expected: PASS（pumpStream 既有 4 条 + 新增 2 条）

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/ai-handlers.ts src/main/ipc/ai-handlers.test.ts
git commit -m "feat(ai): track in-flight streams by conversation for targeted abort"
```

---

### Task 3: `runSend.onFinish` 会话存在 guard（回归测试 + 重构）

**Files:**

- Modify: `src/main/ai/send.ts`
- Test: `src/main/ai/send.test.ts`

**为什么（诚实标注——这不是严格 TDD 红灯）：** 没有 guard 时，删除中流会话 → `onFinish` 的 `appendMessage` 撞 FK 抛错 → 被 drain 的防御性 catch 吞掉并 `log.warn`，外部行为与 guard 后**不可区分**（消息反正都没了）。guard 的价值是把「会话已删」从异常路径显式化为预期分支：消除误导排查的吞错日志、不再依赖 catch-all 兜底。故本任务为「行为回归测试（写完即绿）+ guard 重构 + 确认仍绿」。

- [ ] **Step 1: 写回归测试**

在 `src/main/ai/send.test.ts` 的 `describe("runSend", ...)` 内、`"persists an aborted-status assistant message..."` 用例之后追加（`deleteConversation` 加入文件顶部既有的 `@main/chat/conversations` import）：

```ts
it("drops the assistant persist when the conversation is deleted mid-stream", async () => {
  const controller = new AbortController();
  // 延迟分片：abort+delete 发生在分片尚未发完时（镜像 conversations:delete 的服务端顺序）。
  const slowModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 50,
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "partial" },
          { type: "text-end", id: "t1" },
          finishChunk("stop"),
        ],
      }),
    }),
  });
  const { db, book, deps } = await setup({ ok: true, model: slowModel, modelId: "mock" });
  const convo = createConversation(db, { bookId: book.id });
  const r = runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // 镜像 conversations:delete binding 的顺序：先 abort 在跑流，再删行
  controller.abort();
  deleteConversation(db, convo.id);
  await r.finished; // 顺利收尾，不抛
  expect(getConversation(db, convo.id)).toBeNull();
  expect(listMessages(db, convo.id)).toEqual([]); // 无孤儿消息（user 已级联删，assistant 不落）
});
```

- [ ] **Step 2: 跑测试确认通过（回归基线）**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS（当前实现下 FK 错误被 drain catch 吞掉、行为已正确——本测试守住该行为）

- [ ] **Step 3: 加 guard 重构**

在 `src/main/ai/send.ts` 的 `onFinish: ({ responseMessage, isAborted }) => {` 回调体**最前面**插入：

```ts
// 会话可能在流中途被删除（conversations:delete 先 abort 在跑流再删行）：此时行已不在，
// 落库必撞 FK。这是删除操作的预期后续而非失败——有意丢弃本轮 assistant 消息，仅留 debug 痕迹。
// 同步回调内 check-then-act 安全（better-sqlite3 同步驱动，无写入穿插）。
const stillExists = db
  .select({ id: conversations.id })
  .from(conversations)
  .where(eq(conversations.id, conversationId))
  .get();
if (!stillExists) {
  log.debug("conversation deleted mid-stream; dropping assistant persist", conversationId);
  return;
}
```

（`conversations` / `eq` 本文件已 import；guard 的 `return` 同时跳过 complete 分支的 auto-naming 触发。）

- [ ] **Step 4: 跑测试确认仍绿**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS（全部既有 + 新增 1 条）

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/send.ts src/main/ai/send.test.ts
git commit -m "feat(ai): drop assistant persist when conversation deleted mid-stream"
```

---

### Task 4: IPC 契约 + delete binding + preload 暴露（双漂移测试做红灯）

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/chat-handlers.ts`
- Modify: `src/preload-api.ts`

- [ ] **Step 1: 加契约（制造红灯）**

在 `src/shared/ipc.ts` 的 `conversationsGet` 定义之后加：

```ts
conversationsDelete: def("conversations:delete", "invoke", conversationIdInput, out<void>()),
```

（`conversationIdInput` 本文件已 import，与 `conversationsGet` 共用 `{ id }` 形状。）

- [ ] **Step 2: 跑漂移测试确认双红**

Run: `pnpm test src/main/ipc/bindings-coverage.test.ts src/preload-api.test.ts`
Expected: FAIL ×2 —— bindings-coverage（`conversations:delete` 无 binding）+ preload coverage（未暴露且不在 KNOWN_MAIN_ONLY）

- [ ] **Step 3: 加 binding**

`src/main/ipc/chat-handlers.ts` 整体改为：

```ts
// src/main/ipc/chat-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { abortConversationStreams } from "@main/ipc/ai-handlers";
import { bind, register, type Binding } from "@main/ipc/registry";

export const chatBindings: Binding[] = [
  bind(C.conversationsListByBook, (input) => listConversationsByBook(getDb(), input.bookId)),
  bind(C.conversationsCreate, (input) => createConversation(getDb(), input)),
  bind(C.conversationsGet, (input) => getConversation(getDb(), input.id)),
  bind(C.conversationsDelete, (input) => {
    // 先中止该会话的在跑流（防删行后继续推送/落库），再删行（messages 级联）。
    abortConversationStreams(input.id);
    deleteConversation(getDb(), input.id);
  }),
  bind(C.messagesListByConversation, (input) => listMessages(getDb(), input.conversationId)),
  bind(C.aiBuildChips, buildChips),
];

export function registerChatHandlers(): void {
  register(chatBindings);
}
```

- [ ] **Step 4: 加 preload 暴露**

`src/preload-api.ts` 的 `chat.conversations` 改为：

```ts
conversations: {
  listByBook: inv(C.conversationsListByBook),
  create: inv(C.conversationsCreate),
  delete: inv(C.conversationsDelete),
},
```

- [ ] **Step 5: 跑漂移测试确认双绿**

Run: `pnpm test src/main/ipc/bindings-coverage.test.ts src/preload-api.test.ts`
Expected: PASS ×2

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/chat-handlers.ts src/preload-api.ts
git commit -m "feat(ipc): wire conversations:delete with in-flight stream abort"
```

---

### Task 5: ConversationsTab 删除 UI（右键菜单 + hover 垃圾桶 + 确认 + 回落）

**Files:**

- Modify: `src/renderer/reader/ConversationsTab.tsx`
- Modify: `src/shared/i18n/locales/zh-CN.ts`（经 `pnpm i18n:extract` 自动同步）
- Modify: `src/shared/i18n/locales/en.ts`（手动补翻译）

**设计要点：**

- 行本身是 `<button>`，hover 垃圾桶**不能嵌套其中**（HTML 禁止 button 套 button）→ 垃圾桶做 absolute 定位的兄弟元素，外层 `div.group.relative` 由 `ContextMenuTrigger render` 提供。
- 时间戳 `group-hover:opacity-0`（保留布局占位防跳动），垃圾桶 `hidden group-hover:flex` 覆盖其上。
- AlertDialog 提升到 Tab 层共享一个（`confirmTarget` state），右键菜单与垃圾桶两条路径汇入。
- onSuccess 顺序硬约束：**先**清 active（防 dangling 窗口内向已删会话发送）**再**失效列表；messages 缓存用 `removeQueries`（实体已没，不该 refetch——镜像 deleteBook 的理由）。
- 渲染层启用 React Compiler：**不写** useCallback/useMemo。
- 逻辑方向类（`end-2` / `ms-auto`），勿用 `right-2`。

- [ ] **Step 1: 重写 ConversationsTab**

`src/renderer/reader/ConversationsTab.tsx` 整体替换为：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ConversationDto } from "@shared/chat";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useChatStore } from "@renderer/store/chat-store";
import { relativeTime } from "@renderer/lib/relative-time";
import { conversationsQuery } from "@renderer/query/conversation-queries";
import { qk } from "@renderer/query/keys";

export function ConversationsTab({ bookId }: { bookId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const activeId = useChatStore((s) => s.activeConversationId);
  const openConversation = useChatStore((s) => s.openConversation);
  const convos = useQuery(conversationsQuery(bookId));
  const [confirmTarget, setConfirmTarget] = useState<ConversationDto | null>(null);

  // 删会话：abort 在跑流 + 级联删消息由主进程负责；成功后先清 active 再失效列表 + toast。
  const deleteConvo = useMutation({
    mutationFn: (c: ConversationDto) => window.api.chat.conversations.delete({ id: c.id }),
    onSuccess: (_r, c) => {
      // 先清 active（防 dangling 窗口内向已删会话发送），再失效列表。
      // 回落 = 新会话空状态（issue #30）：AIPanel 既有 effect 清面板，chips 预亮镜像「开书无会话」。
      const s = useChatStore.getState();
      if (s.activeConversationId === c.id) {
        s.setActiveConversation(null);
        s.setSummaryChipsPreset();
      }
      // 该会话的消息缓存整体移除（remove 非 invalidate——实体已没，不该 refetch；镜像 deleteBook）。
      qc.removeQueries({ queryKey: qk.messages(c.id) });
      void qc.invalidateQueries({ queryKey: qk.conversations(bookId) });
      toast.success(t("reader.conversation.deleted", "已删除会话"));
    },
    onError: (e) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("reader.conversation.deleteFailed", "删除失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  if (convos.isPending)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {t("reader.conversation.loading", "加载会话…")}
      </p>
    );
  if (convos.isError)
    return (
      <p className="p-3 text-sm text-destructive">
        {t("reader.conversation.loadError", "会话加载失败")}
      </p>
    );
  const list = convos.data ?? [];
  if (list.length === 0)
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("reader.conversation.empty", "还没有会话。选段问 AI 试试～")}
      </p>
    );

  const primaryLabel = (c: ConversationDto): string =>
    c.title?.trim() ? c.title : t("reader.conversation.untitled", "未命名会话");
  const now = Date.now();

  return (
    <>
      <ScrollArea className="h-full">
        <div className="space-y-1 p-2">
          {list.map((c) => (
            <ConversationRow
              key={c.id}
              convo={c}
              active={c.id === activeId}
              label={primaryLabel(c)}
              time={relativeTime(c.updatedAt, now, i18n.language)}
              onOpen={() => openConversation(c.id)}
              onDeleteRequest={() => setConfirmTarget(c)}
            />
          ))}
        </div>
      </ScrollArea>

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("reader.conversation.deleteConfirm.title", "删除会话「{{title}}」？", {
              title: confirmTarget ? primaryLabel(confirmTarget) : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "reader.conversation.deleteConfirm.body",
              "将永久删除该会话及其全部消息。此操作不可撤销。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              {t("reader.conversation.deleteConfirm.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmTarget) deleteConvo.mutate(confirmTarget);
                setConfirmTarget(null);
              }}
            >
              {t("reader.conversation.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 单条会话行：行按钮 + hover 垃圾桶（绝对定位兄弟，不嵌套 button）+ 右键菜单，两条删除路径汇入同一确认。 */
function ConversationRow({
  convo,
  active,
  label,
  time,
  onOpen,
  onDeleteRequest,
}: {
  convo: ConversationDto;
  active: boolean;
  label: string;
  time: string;
  onOpen: () => void;
  onDeleteRequest: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative" />}>
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-transparent p-2 text-start",
            active ? "bg-accent" : "hover:bg-muted",
          )}
        >
          <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              convo.isNaming ? "animate-pulse text-muted-foreground" : "text-foreground",
            )}
          >
            {label}
          </span>
          {/* 保留布局占位（opacity 而非 hidden）防 hover 时行宽跳动 */}
          <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover:opacity-0">
            {time}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDeleteRequest}
          aria-label={t("reader.conversation.deleteAction", "删除会话")}
          className="absolute end-1 top-1/2 hidden -translate-y-1/2 text-muted-foreground hover:text-destructive group-hover:flex"
        >
          <Trash2 />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onDeleteRequest}>
          {t("reader.conversation.menu.delete", "删除")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

- [ ] **Step 2: 同步 i18n（extract 先于 typecheck——操作顺序坑）**

Run: `pnpm i18n:extract`
Expected: `src/shared/i18n/locales/zh-CN.ts` 自动新增 7 个键（fallback 即中文文案）：
`reader.conversation.deleteAction` / `reader.conversation.menu.delete` / `reader.conversation.deleteConfirm.title` / `.body` / `.cancel` / `.confirm` / `reader.conversation.deleted` / `reader.conversation.deleteFailed`

然后 `git diff src/shared/i18n/locales/` **逐行检查**：只新增了上述键，没有反向覆盖其他既有键（已知坑：extract 会用代码里的旧 fallback 覆盖 locale 文件的修正）。

- [ ] **Step 3: 手动补 en 翻译**

在 `src/shared/i18n/locales/en.ts` 的 `reader.conversation.*` 区块（按字母序插入）：

```ts
"reader.conversation.deleteAction": "Delete conversation",
"reader.conversation.deleteConfirm.body":
  "This will permanently delete the conversation and all of its messages. This cannot be undone.",
"reader.conversation.deleteConfirm.cancel": "Cancel",
"reader.conversation.deleteConfirm.confirm": "Delete",
"reader.conversation.deleteConfirm.title": "Delete conversation “{{title}}”?",
"reader.conversation.deleted": "Conversation deleted",
"reader.conversation.deleteFailed": "Failed to delete: {{error}}",
"reader.conversation.menu.delete": "Delete",
```

注意：`deleteConfirm.title` 用**弯引号** U+201C/U+201D（镜像 `library.deleteConfirm.title` 的 `Delete “{{title}}”?`）。提交后逐字符确认引号未被格式化器吞掉（已知 oxfmt 坑在正则字符类，字符串字面量一般安全，但仍须目检 diff）。

- [ ] **Step 4: 类型与 lint 检查**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/ConversationsTab.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(renderer): add conversation deletion with context menu and hover action

closes #30"
```

（prek 钩子若报 "files were modified by this hook"：重新 `git add` 被改文件后原命令重跑一次。）

---

### Task 6: 全量验证 + changeset + 冒烟

**Files:**

- Create: `.changeset/<随机名>.md`（`pnpm changeset` 生成）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（含 bindings-coverage、preload coverage、conversations、ai-handlers、send 的新旧用例）

- [ ] **Step 2: 写 changeset**

Run: `pnpm changeset`（选 minor），条目正文：

```
Conversations in the sidebar can now be deleted — right-click one or hover and hit the trash icon, then confirm. Deleting the active conversation clears the panel back to a fresh-start state, and any in-flight AI reply for it is stopped.
```

- [ ] **Step 3: 手动冒烟（pnpm start，勿污染真实数据用 dev 即可——dev 已分库）**

冒烟清单：

1. 开一本书 → 侧栏会话 tab → hover 一条会话：时间戳淡出、垃圾桶浮现；右键同一条：出现红色「删除」项。
2. 两条路径都点 → 弹同一确认对话框，标题带会话名（未命名会话显示占位）。
3. 删除**非活跃**会话 → 列表即刻消失 + toast；活跃会话不受影响。
4. 删除**活跃**会话 → AI 面板清空回「新会话空状态」（摘要 chips 预亮）；再发一条消息 → 正常懒建新会话。
5. **删除正在流式输出的活跃会话**（发长问题后立刻删）→ 流停止、面板清空、无报错弹窗；`userData/logs/main-*.log` 无 FK constraint 报错（可有 `conversation deleted mid-stream` debug 行）。
6. 取消路径：确认框点「取消」→ 无事发生。

- [ ] **Step 4: 完成分支收尾**

用 superpowers:finishing-a-development-branch 流程（rebase 合 main、ROADMAP 不需更新——需求已迁 kanban；关 issue #30 + kanban 卡挪 Done）。

---

## Self-Review 记录

- **Spec 覆盖**：issue 正文 4 要素（删除入口✅ Task 5 / 确认✅ Task 5 / 级联✅ Task 1 / 活跃回落✅ Task 5 onSuccess）+ 评论 4 坑（mid-stream abort✅ Task 2+4 / naming race✅ 已免疫-背景节 / dangling window✅ onSuccess 顺序 / removeQueries✅）。
- **类型一致性**：`deleteConversation(db, id)`（Task 1 定义 = Task 3/4 调用）；`abortConversationStreams(conversationId)`（Task 2 定义 = Task 4 调用）；`window.api.chat.conversations.delete({ id })`（Task 4 暴露 = Task 5 调用，入参形状 = `conversationIdInput`）。
- **诚实标注**：Task 3 非严格红灯（外部行为不可区分），已写明缘由。
