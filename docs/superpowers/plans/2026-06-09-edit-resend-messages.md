# 聊天消息「编辑重发 / 直接重发·再生成」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让 AI 面板的 user 消息可「编辑后重发」、user/assistant 可「直接重发/再生成」——截断该轮之后的消息、从（编辑后的）user 轮重新流式生成回复。

**Architecture:** 主进程把 `runSend` 的流式尾段抽为共享 `streamAssistantReply`，新增 `runResend`（设文本+截断+从持久化消息组 prompt+流式），经新 `ai:resend` IPC 暴露。渲染层 transport 按 `trigger` 把 `regenerate()` 路由到 `ai:resend`；编辑用 `flushSync(setMessages 改文本)`+`regenerate`；轮结束从 DB 重载消息同步 id。UI 扩展 #67 的 `MessageToolbar`（user: Edit+Resend；assistant: Regenerate）+ UserBubble 就地编辑。

**Tech Stack:** Electron 主进程 + Drizzle/better-sqlite3 + AI SDK v6（`streamText`/`useChat`/`regenerate`）+ React 19（React Compiler）+ Zod 4 + vitest 4。

设计文档：`docs/superpowers/specs/2026-06-09-edit-resend-messages-design.md`

## 关键约定（执行前必读）

- **栈式分支**：当前分支 `feat/edit-resend-messages` 基于 #67（`feat/copy-ai-chat-messages`）。`MessageToolbar` / `CopyButton` / `message-text.ts` 已存在（#67 产物），本计划扩展之。
- **测试运行**：`pnpm test <file>` 跑单文件；`pnpm test src/main/ai` 跑目录。主进程测试用 `:memory:` + `MockLanguageModelV3`（见 `src/main/ai/send.test.ts` 的 `setup`/`makeDeps`/`textStreamModel`/`promptCapturingModel`——新测试**镜像**这些工厂）。
- **i18n 顺序**：加 `t("key","中文")` 后**先 `pnpm i18n:extract` 再 `pnpm typecheck`**（i18next.d.ts 键类型从 zh-CN.ts 推导）。extract 灌 zh-CN.ts、给 en.ts 留空串待填。跑后 `git diff src/shared/i18n/locales` 自查仅新增键。`pnpm i18n:lint` 有 **3 个既存失败**（`ErrorBoundary.tsx`/`PdfReader.tsx`，与本特性无关，勿改）。
- **pre-commit（prek）**：commit 触发 lint:fix+format，可能改文件并中止；遇到 `git add` 改动文件后重跑同一 commit（跑 i18n:extract 后先 `pnpm format` 可避免）。勿 `--no-verify`。
- **React Compiler**：勿手写 useCallback/useMemo；命令式 effect 清理/聚焦仍手写。`flushSync` 用于「改状态后同步读」（同 `composer-focus.ts` 既有用法）。
- **日志**：无裸 console.\*；`createLogger("send")`(主) / `createLogger("ai")`(渲染)；err 作第二参。
- 提交 Conventional Commits，末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 文件结构

| 文件                                    | 职责                                                               | 动作    |
| --------------------------------------- | ------------------------------------------------------------------ | ------- |
| `src/main/chat/messages.ts`             | +`getMessage`、+`resetUserTurnForResend`                           | 改      |
| `src/main/chat/messages.test.ts`        | 上述 helper 单测                                                   | 改      |
| `src/main/ai/stream-assistant.ts`       | 共享流式尾段（runSend/runResend 共用）                             | 新建    |
| `src/main/ai/prompt.ts`                 | `assemblePrompt` current.chips 放宽为 ChipLike                     | 改      |
| `src/main/ai/send.ts`                   | runSend 改用 streamAssistantReply；+`runResend`                    | 改      |
| `src/main/ai/send.test.ts`              | 既有全绿（回归）；+runResend 用例                                  | 改      |
| `src/shared/chat.ts`                    | +`resendInputSchema`/`resendRequest`/`ResendInput`/`ResendRequest` | 改      |
| `src/shared/ipc.ts`                     | +`aiResend` 通道                                                   | 改      |
| `src/main/ipc/ai-handlers.ts`           | +`ai:resend` binding                                               | 改      |
| `src/preload-api.ts`                    | +`ai.resend`                                                       | 改      |
| `src/renderer/ai/ipc-chat-transport.ts` | +resend 分支（按 trigger）                                         | 改      |
| `src/renderer/ai/chat-actions.ts`       | ChatActions context + `nextAssistantId`                            | 新建    |
| `src/renderer/ai/chat-actions.test.ts`  | `nextAssistantId` 单测                                             | 新建    |
| `src/renderer/ai/AIPanel.tsx`           | actions 构造+Provider；轮结束 DB 重载同步 id                       | 改      |
| `src/renderer/ai/MessageToolbar.tsx`    | 按 role 渲染 Edit/Resend/Regenerate                                | 改      |
| `src/renderer/ai/MessageEditor.tsx`     | 就地编辑 textarea                                                  | 新建    |
| `src/renderer/ai/MessageList.tsx`       | UserBubble 编辑态                                                  | 改      |
| `src/shared/i18n/locales/{zh-CN,en}.ts` | +5 键                                                              | 改/生成 |
| `.changeset/edit-resend-messages.md`    | changelog                                                          | 新建    |

---

## Task 1: messages 层 truncate/edit helper

**Files:** `src/main/chat/messages.ts`(改)、`src/main/chat/messages.test.ts`(改)

- [ ] **Step 1: 写失败测试** — 在 `src/main/chat/messages.test.ts` 末尾追加（沿用文件既有的 `createDb(":memory:")`+`runMigrations`+`createConversation`+`appendMessage` 设置；若文件无这些 import 则按既有测试补齐）：

```ts
describe("getMessage", () => {
  it("returns the message dto or null", () => {
    const db = freshConvoDb(); // 见下方说明：建库+迁移+建会话，返回 {db, convoId}
    const { db: d, convoId } = db;
    const m = appendMessage(d, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(getMessage(d, m.id)?.id).toBe(m.id);
    expect(getMessage(d, "nope")).toBeNull();
  });
});

describe("resetUserTurnForResend", () => {
  it("sets the user text, deletes everything after it, and returns its seq", () => {
    const { db, convoId } = freshConvoDb();
    const u = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "old" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u2" }],
    });
    const seq = resetUserTurnForResend(db, convoId, u.id, "new");
    expect(seq).toBe(u.seq);
    const left = listMessages(db, convoId);
    expect(left).toHaveLength(1);
    expect(left[0].parts).toEqual([{ type: "text", text: "new" }]);
  });

  it("preserves the user message metadata snapshot", () => {
    const { db, convoId } = freshConvoDb();
    const u = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "q" }],
      metadata: { contextChips: [{ id: "selection", content: "sel", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
    });
    resetUserTurnForResend(db, convoId, u.id, "edited");
    expect(getMessage(db, u.id)?.metadata?.contextChips).toEqual([
      { id: "selection", content: "sel", tokenCount: 1 },
    ]);
  });

  it("resets the rolling summary when truncating into or before the summarized boundary", () => {
    const { db, convoId } = freshConvoDb();
    const u0 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u0" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a0" }],
    });
    db.update(conversations)
      .set({ contextSummary: "S", summarizedThroughSeq: u0.seq + 1 })
      .where(eq(conversations.id, convoId))
      .run();
    resetUserTurnForResend(db, convoId, u0.id, "u0"); // S(seq+1) >= u0.seq → reset
    const c = db
      .select({ s: conversations.summarizedThroughSeq, sum: conversations.contextSummary })
      .from(conversations)
      .where(eq(conversations.id, convoId))
      .get();
    expect(c?.s).toBeNull();
    expect(c?.sum).toBeNull();
  });

  it("keeps the rolling summary when the boundary is older than the truncation point", () => {
    const { db, convoId } = freshConvoDb();
    const u0 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u0" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a0" }],
    });
    const u1 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u1" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
    });
    db.update(conversations)
      .set({ contextSummary: "S", summarizedThroughSeq: u0.seq })
      .where(eq(conversations.id, convoId))
      .run();
    resetUserTurnForResend(db, convoId, u1.id, "u1"); // boundary(u0.seq) < u1.seq → keep
    const c = db
      .select({ s: conversations.summarizedThroughSeq, sum: conversations.contextSummary })
      .from(conversations)
      .where(eq(conversations.id, convoId))
      .get();
    expect(c?.s).toBe(u0.seq);
    expect(c?.sum).toBe("S");
  });
});
```

测试辅助 `freshConvoDb`（加到该测试文件顶部 helper 区，若已有等价物则复用）：

```ts
import { createDb, runMigrations } from "@main/db/client";
import { createConversation } from "@main/chat/conversations";
import { importBook } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { conversations } from "@main/db/schema";
import { eq } from "drizzle-orm";
import path from "node:path";
const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshConvoDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  // book.id 是 epub 自然键；建会话需有效 bookId
  return importBook(db, { bytes: makeFixtureEpub() }).then((book) => ({
    db,
    convoId: createConversation(db, { bookId: book.id }).id,
  }));
}
```

> 注意：`importBook` 是 async，故 `freshConvoDb` 返回 Promise——上面用例改成 `const { db, convoId } = await freshConvoDb();`（每个 `it` 标 async）。请据此把各 `it` 写成 `async () => { const { db, convoId } = await freshConvoDb(); … }`。

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/main/chat/messages.test.ts` → FAIL（`getMessage`/`resetUserTurnForResend` 未定义）。

- [ ] **Step 3: 实现** — 在 `src/main/chat/messages.ts` 顶部 import 增补 `conversations`（已 import `messages`；`and/eq/gt` 已在）。文件已 `import { conversations, messages } from "@main/db/schema"`。追加两函数：

```ts
/** 取单条消息 dto；无则 null。 */
export function getMessage(db: DB, messageId: string): MessageDto | null {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get();
  return row ? toDto(row) : null;
}

/**
 * 重置 user 轮以重发（事务）：① 设该 user 消息 parts=[{text}]（保留 metadata 快照）；
 * ② 删 seq > 其 seq 的全部消息；③ 若 summarizedThroughSeq >= 其 seq，重置滚动摘要
 * （contextSummary=null, summarizedThroughSeq=null，否则摘要引用已删消息）；④ 推进 updatedAt。
 * 返回该 user 消息 seq。调用方须已校验 messageId 为本会话 user 消息。
 */
export function resetUserTurnForResend(
  db: DB,
  conversationId: string,
  messageId: string,
  text: string,
): number {
  return db.transaction((tx) => {
    const row = tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .get();
    if (!row) throw new Error("message not found in conversation");
    const seq = row.seq;
    tx.update(messages)
      .set({ parts: [{ type: "text", text }] })
      .where(eq(messages.id, messageId))
      .run();
    tx.delete(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, seq)))
      .run();
    const convo = tx
      .select({ s: conversations.summarizedThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    const resetSummary = convo?.s != null && convo.s >= seq;
    tx.update(conversations)
      .set({
        updatedAt: Date.now(),
        ...(resetSummary ? { contextSummary: null, summarizedThroughSeq: null } : {}),
      })
      .where(eq(conversations.id, conversationId))
      .run();
    return seq;
  });
}
```

- [ ] **Step 4: 跑测试确认通过** — `pnpm test src/main/chat/messages.test.ts` → PASS。

- [ ] **Step 5: typecheck** — `pnpm typecheck` → 干净。

- [ ] **Step 6: 提交**

```bash
git add src/main/chat/messages.ts src/main/chat/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): add getMessage and resetUserTurnForResend helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 抽出共享流式尾段 + 放宽 assemblePrompt + 重构 runSend

**Files:** `src/main/ai/stream-assistant.ts`(新)、`src/main/ai/prompt.ts`(改)、`src/main/ai/send.ts`(改)

纯重构，行为不变，**靠既有 `send.test.ts` 全绿作回归**。

- [ ] **Step 1: 放宽 `assemblePrompt`** — 在 `src/main/ai/prompt.ts`：`AssemblePromptParams.current.chips` 由 `Chip[]` 改为 `ChipLike`（文件已有 `type ChipLike = ReadonlyArray<{ id: string; content: string }>`，但定义在文件中部——把它上移到 `AssemblePromptParams` 之前，或直接内联类型）。最小改动：

把

```ts
  current: { chips: Chip[]; userText: string; readingContext?: ReadingContext | null };
```

改为

```ts
  current: { chips: ReadonlyArray<{ id: string; content: string }>; userText: string; readingContext?: ReadingContext | null };
```

（`renderUserTurn(params.current.chips, …)` 已接受 ChipLike，无其他改动。`Chip` 若因此变未使用则保留——它仍被 `chipContent` 的 `Chip["id"]` 用到。）

- [ ] **Step 2: 创建 `src/main/ai/stream-assistant.ts`**（把 send.ts 现 §6–§7 整段迁入、参数化）：

```ts
// src/main/ai/stream-assistant.ts
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { eq } from "drizzle-orm";
import { conversations } from "@main/db/schema";
import { createReadingTools } from "@main/ai/tools";
import { supportsImageToolResults } from "@main/ai/model-factory";
import { maybeCompactConversation } from "@main/ai/context-compaction";
import { nameConversation } from "@main/chat/conversation-title";
import { appendMessage } from "@main/chat/messages";
import { textOfParts } from "@main/ai/prompt";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { SendDeps } from "@main/ai/send";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";
import { createLogger } from "@main/logger";

const log = createLogger("send");

type ResolvedOk = Extract<ResolvedModel, { ok: true }>;

/** runSend / runResend 共用的成功返回形状。 */
export interface OkSendResult {
  ok: true;
  conversationId: string;
  stream: AsyncIterable<UIMessageChunk>;
  finished: Promise<void>;
}

export interface StreamCtx {
  conversationId: string;
  bookId: string;
  resolved: ResolvedOk;
  /** 本轮 user 文本（首轮自动命名用）。 */
  userText: string;
}

/**
 * 共享流式尾段：streamText + tools 跑 agent 循环，一轮终止时落终态 assistant
 * （complete|error|aborted），首轮自动命名 + 轮后压缩。从 runSend 抽出供 runResend 复用。
 */
export function streamAssistantReply(
  deps: SendDeps,
  ctx: StreamCtx,
  messages: ModelMessage[],
  systemPrompt: string | undefined,
  opts?: { abortSignal?: AbortSignal },
): OkSendResult {
  const { db, loadBytes, resolveSummaryModel, stepLimit } = deps;
  const { conversationId, bookId, resolved } = ctx;
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  const tools = createReadingTools({ db, bookId, loadBytes, imageToolResults });

  let capturedUsage: LanguageModelUsage | undefined;
  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;
  const result = streamText({
    model: resolved.model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: limit === 0 ? () => false : stepCountIs(limit),
    abortSignal: opts?.abortSignal,
    onFinish: ({ totalUsage }) => {
      capturedUsage = totalUsage;
    },
    onStepFinish: ({ finishReason, toolCalls, text }) => {
      log.debug(
        `step finished (finishReason=${finishReason}, toolCalls=${toolCalls.length}, textChars=${text.length})`,
      );
    },
  });

  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  let streamHadError = false;
  let errorInfo: { name: string; message: string } | undefined;
  const uiStream = result.toUIMessageStream({
    onError: (err) => {
      streamHadError = true;
      errorInfo = {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      };
      log.warn("stream/model error", err);
      return errorInfo.message;
    },
    onFinish: ({ responseMessage, isAborted }) => {
      const stillExists = db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get();
      if (!stillExists) {
        log.debug("conversation deleted mid-stream; dropping assistant persist", conversationId);
        return;
      }
      const status = streamHadError ? "error" : isAborted ? "aborted" : "complete";
      const usage =
        capturedUsage?.inputTokens != null && capturedUsage.outputTokens != null
          ? { inputTokens: capturedUsage.inputTokens, outputTokens: capturedUsage.outputTokens }
          : undefined;
      appendMessage(db, {
        conversationId,
        role: "assistant",
        parts: responseMessage.parts,
        status,
        metadata: {
          model: resolved.modelId,
          usage,
          error: streamHadError ? errorInfo : undefined,
        },
      });
      if (status === "complete") {
        const assistantText = textOfParts(responseMessage.parts);
        const row = db
          .select({ title: conversations.title })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get();
        if (assistantText && row && row.title == null) {
          void nameConversation(
            { db, resolveModel: resolveSummaryModel },
            conversationId,
            ctx.userText,
            assistantText,
          );
        }
        void maybeCompactConversation({ db, resolveModel: resolveSummaryModel }, conversationId);
      }
    },
  });

  const [internalStream, callerStream] = uiStream.tee();
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of internalStream) {
        // drain
      }
    } catch (err) {
      log.warn("assistant persist / stream drain failed", err);
    } finally {
      resolveDone();
    }
  })();

  return { ok: true, conversationId, stream: callerStream, finished };
}
```

- [ ] **Step 3: 重构 `send.ts`** — 改 `SendResult` 复用 `OkSendResult`；`runSend` 末段换成 `streamAssistantReply` 调用。

顶部 import 增补：`import { streamAssistantReply, type OkSendResult } from "@main/ai/stream-assistant";`。可删除 send.ts 中仅被旧尾段使用、现已移走的 import（`stepCountIs`、`streamText`、`LanguageModelUsage`、`UIMessageChunk`、`createReadingTools`/`LoadBytes`（若 runSend 不再直接用）、`maybeCompactConversation`、`nameConversation`、`appendMessage` 仍被 runSend 的「落 user 消息」用故保留、`textOfParts` 若 runSend 不再用则删、`DEFAULT_STEP_LIMIT` 移走）。**以 typecheck/lint 的 unused 报错为准逐一清理**，勿误删仍用到的（`appendMessage`、`assemblePrompt`、`getDefaultAssistant`、`getBook`、`dedupeParagraph`/`toContextChips`、`pdfSystemNote`、`supportsImageToolResults`、`listMessagesAfterSeq`、`getLastParagraphContent`、`conversations`、`eq` 等仍用）。

把 `SendResult` 定义改为：

```ts
export type SendResult = OkSendResult | { ok: false; reason: string };
```

（删除原内联的 ok 形状；`LoadBytes` 仍被 `SendDeps` 间接需要——`SendDeps.loadBytes: LoadBytes` 保留其 import。）

`runSend` 从「// 6. streamText…」起到 `return { ok:true, … }` 整段（原 125–251 行）替换为：

```ts
// 6. 流式回复（共享尾段）
return streamAssistantReply(
  deps,
  { conversationId, bookId: input.bookId, resolved, userText: input.userText },
  messages,
  systemPrompt,
  opts,
);
```

（此处 `resolved` 已被 §1 的 `if (!resolved.ok) return …` 守卫窄化为 ok 变体，类型满足 `ResolvedOk`。`messages`/`systemPrompt` 为 §5 组装并提取 system 后的变量，保持不变。）

- [ ] **Step 4: typecheck + lint** — `pnpm typecheck && pnpm lint` → 干净（按 unused 报错清理 import）。

- [ ] **Step 5: 回归测试** — `pnpm test src/main/ai/send.test.ts` → 全绿（行为不变）。再 `pnpm test src/main/ai` → 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/main/ai/stream-assistant.ts src/main/ai/prompt.ts src/main/ai/send.ts
git commit -m "$(cat <<'EOF'
refactor(ai): extract streamAssistantReply shared by send/resend

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: runResend + ai:resend IPC

**Files:** `src/main/ai/send.ts`(改)、`src/main/ai/send.test.ts`(改)、`src/shared/chat.ts`(改)、`src/shared/ipc.ts`(改)、`src/main/ipc/ai-handlers.ts`(改)、`src/preload-api.ts`(改)

- [ ] **Step 1: 写失败测试**（`src/main/ai/send.test.ts` 末尾追加；复用既有 `setup`/`textStreamModel`/`promptCapturingModel`/`appendMessage`/`listMessages`）：

```ts
describe("runResend", () => {
  beforeEach(() => __resetNamingRuntime());

  async function seedTurn(deps: SendDeps, db: ReturnType<typeof createDb>, bookId: string) {
    const convo = createConversation(db, { bookId });
    const r = runSend(deps, input(bookId, convo.id, { userText: "first question" }));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    return convo;
  }

  it("rejects when the model is unconfigured without mutating", async () => {
    const { db, book, deps } = await setup({ ok: false, reason: "no model" });
    const convo = createConversation(db, { bookId: book.id });
    const u = appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "q" }],
    });
    const r = runResend(deps, { conversationId: convo.id, userMessageId: u.id, userText: "q" });
    expect(r.ok).toBe(false);
    expect(listMessages(db, convo.id)).toHaveLength(1); // unchanged
  });

  it("rejects an unknown / non-user / cross-conversation message", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("x"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const a = appendMessage(db, {
      conversationId: convo.id,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
    });
    expect(
      runResend(deps, { conversationId: convo.id, userMessageId: "nope", userText: "x" }).ok,
    ).toBe(false);
    expect(
      runResend(deps, { conversationId: convo.id, userMessageId: a.id, userText: "x" }).ok,
    ).toBe(false); // assistant
  });

  it("truncates after the user message and streams a fresh assistant reply", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("regenerated"),
      modelId: "mock",
    });
    const convo = await seedTurn(deps, db, book.id);
    const msgs = listMessages(db, convo.id);
    const user = msgs.find((m) => m.role === "user")!;
    const r = runResend(deps, {
      conversationId: convo.id,
      userMessageId: user.id,
      userText: "first question",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const after = listMessages(db, convo.id);
    expect(after.map((m) => m.role)).toEqual(["user", "assistant"]); // old assistant replaced, no dup user
    const assistantText = after[1].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(assistantText).toContain("regenerated");
  });

  it("applies the edited user text and sends it to the model", async () => {
    const captured: { system?: string; texts: string[] } = { texts: [] };
    const { db, book, deps } = await setup({
      ok: true,
      model: promptCapturingModel(captured),
      modelId: "mock",
    });
    const convo = await seedTurn(deps, db, book.id);
    const user = listMessages(db, convo.id).find((m) => m.role === "user")!;
    const r = runResend(deps, {
      conversationId: convo.id,
      userMessageId: user.id,
      userText: "EDITED QUESTION",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    expect(getMessage(db, user.id)?.parts).toEqual([{ type: "text", text: "EDITED QUESTION" }]);
    expect(captured.texts.join("\n")).toContain("EDITED QUESTION");
  });
});
```

（顶部补 import：`runResend` from send、`getMessage` from messages。）

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/main/ai/send.test.ts -t runResend` → FAIL（`runResend` 未定义）。

- [ ] **Step 3: 实现 `runResend`**（`src/main/ai/send.ts`，紧接 `runSend` 之后）。顶部 import 增补 `getMessage`、`resetUserTurnForResend`（来自 `@main/chat/messages`，与既有 `appendMessage`/`listMessagesAfterSeq`/`getLastParagraphContent` 同行合并）、`type ResendInput` from `@shared/chat`：

```ts
/** 编辑重发 / 直接重发：设 user 文本 + 截断其后 + 从持久化消息重组 prompt + 流式。 */
export function runResend(
  deps: SendDeps,
  input: ResendInput,
  opts?: { abortSignal?: AbortSignal },
): SendResult {
  const { db, resolveModel } = deps;

  const resolved = resolveModel();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const convo = db
    .select({
      bookId: conversations.bookId,
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();
  if (!convo) {
    return { ok: false, reason: t("errors.conversationNotFound", "会话不存在或不属于本书") };
  }

  const target = getMessage(db, input.userMessageId);
  if (!target || target.conversationId !== input.conversationId || target.role !== "user") {
    return { ok: false, reason: t("errors.messageNotResendable", "消息不存在或不可重发") };
  }

  // 事务：设文本 + 截断其后 + 按需重置摘要
  resetUserTurnForResend(db, input.conversationId, input.userMessageId, input.userText);

  // 重读摘要态（可能刚被重置）
  const c2 = db
    .select({
      contextSummary: conversations.contextSummary,
      summarizedThroughSeq: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();

  // 窗口历史（末条 = 目标 user 轮）
  const window = listMessagesAfterSeq(db, input.conversationId, c2?.summarizedThroughSeq ?? null);
  const current = window.at(-1);
  if (!current) {
    return { ok: false, reason: t("errors.messageNotResendable", "消息不存在或不可重发") };
  }
  const history = window.slice(0, -1);

  // system（同 runSend：默认 Assistant + PDF 注记）
  const assistant = getDefaultAssistant(db);
  const book = getBook(db, convo.bookId);
  const imageToolResults = supportsImageToolResults(resolved.providerType);
  let systemPromptText = assistant.systemPrompt;
  if (book?.format === "pdf") {
    const note = pdfSystemNote({
      pageCount: book.pageCount,
      hasTextLayer: Boolean(book.hasTextLayer),
      imageMode: imageToolResults,
    });
    systemPromptText = systemPromptText ? `${systemPromptText}\n\n${note}` : note;
  }

  const allMessages: ModelMessage[] = assemblePrompt({
    systemPrompt: systemPromptText,
    priorSummary: c2?.contextSummary ?? null,
    history,
    current: {
      chips: current.metadata?.contextChips ?? [],
      userText: textOfParts(current.parts),
      readingContext: null,
    },
  });

  let systemPrompt: string | undefined;
  let messages: ModelMessage[];
  if (allMessages.length > 0 && allMessages[0].role === "system") {
    const sysMsg = allMessages[0];
    systemPrompt = typeof sysMsg.content === "string" ? sysMsg.content : undefined;
    messages = allMessages.slice(1);
  } else {
    messages = allMessages;
  }

  return streamAssistantReply(
    deps,
    {
      conversationId: input.conversationId,
      bookId: convo.bookId,
      resolved,
      userText: input.userText,
    },
    messages,
    systemPrompt,
    opts,
  );
}
```

（确保 send.ts 顶部已 import `textOfParts`——若 Task 2 误删，补回 `import { assemblePrompt, pdfSystemNote, textOfParts } from "@main/ai/prompt"`。`ResendInput` 从 `@shared/chat` import，见 Step 5。）

- [ ] **Step 4: 跑测试确认通过** — `pnpm test src/main/ai/send.test.ts` → 全绿（含 runResend + 既有回归）。

- [ ] **Step 5: IPC schema** — `src/shared/chat.ts` 末尾追加：

```ts
/** ai:resend 业务入参（不含传输层 streamId）。 */
export const resendInputSchema = z.object({
  conversationId: z.string().min(1),
  userMessageId: z.string().min(1),
  userText: z.string().min(1),
});
export type ResendInput = z.infer<typeof resendInputSchema>;
/** ai:resend 入站载体 = 业务入参 + streamId。 */
export const resendRequest = resendInputSchema.extend({ streamId: z.string().min(1) });
export type ResendRequest = z.infer<typeof resendRequest>;
```

`src/shared/ipc.ts` 在 `// ai` 段加（`resendRequest` 需 import；该文件已从 `@shared/chat` 集中 import schema，把 `resendRequest` 加进既有 import 列表）：

```ts
  aiResend: def("ai:resend", "invoke", resendRequest, out<SendAck>()),
```

- [ ] **Step 6: handler + preload** — `src/main/ipc/ai-handlers.ts`：import `runResend`（与 `runSend` 同行），在 `aiBindings` 数组加（紧跟 `aiSend` binding 后，结构镜像之）：

```ts
  bind(C.aiResend, (req, event: IpcMainInvokeEvent): SendAck => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    activeStreams.set(streamId, { controller, conversationId: input.conversationId });
    const result = runResend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      activeStreams.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      activeStreams.delete(streamId);
    });
    return { ok: true, conversationId: result.conversationId };
  }),
```

`src/preload-api.ts` 的 `ai:` 块加 `resend: inv(C.aiResend),`（在 `send`/`abort` 旁）。

- [ ] **Step 7: typecheck + lint + 全量主进程测试** — `pnpm typecheck && pnpm lint && pnpm test src/main` → 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/main/ai/send.ts src/main/ai/send.test.ts src/shared/chat.ts src/shared/ipc.ts src/main/ipc/ai-handlers.ts src/preload-api.ts
git commit -m "$(cat <<'EOF'
feat(ai): add runResend and ai:resend IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 渲染层 transport 分支 + chat-actions + AIPanel 接线

**Files:** `src/renderer/ai/ipc-chat-transport.ts`(改)、`src/renderer/ai/chat-actions.ts`(新)、`src/renderer/ai/chat-actions.test.ts`(新)、`src/renderer/ai/AIPanel.tsx`(改)

- [ ] **Step 1: 写 `nextAssistantId` 失败测试** — `src/renderer/ai/chat-actions.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { nextAssistantId } from "@renderer/ai/chat-actions";
import type { ChatUIMessage } from "@renderer/ai/types";

const u = (id: string): ChatUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "q" }],
});
const a = (id: string): ChatUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "r" }],
});

describe("nextAssistantId", () => {
  it("returns the assistant immediately following the user message", () => {
    expect(nextAssistantId([u("u1"), a("a1"), u("u2"), a("a2")], "u1")).toBe("a1");
    expect(nextAssistantId([u("u1"), a("a1"), u("u2"), a("a2")], "u2")).toBe("a2");
  });
  it("returns undefined when the user message has no following assistant", () => {
    expect(nextAssistantId([u("u1"), a("a1"), u("u2")], "u2")).toBeUndefined();
  });
  it("returns undefined for an unknown id", () => {
    expect(nextAssistantId([u("u1"), a("a1")], "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm test src/renderer/ai/chat-actions.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 `chat-actions.ts`**：

```ts
import { createContext, useContext } from "react";
import type { ChatUIMessage } from "@renderer/ai/types";

export interface ChatActions {
  /** 直接重发：重跑某 user 轮的回复（不改文本）。 */
  resend(userMessage: ChatUIMessage): void;
  /** 编辑重发：改 user 文本后重跑回复。 */
  editAndResend(userMessage: ChatUIMessage, newText: string): void;
  /** 再生成某 assistant 回复。 */
  regenerate(assistantMessage: ChatUIMessage): void;
  /** 有流在跑时为 true（禁用操作按钮）。 */
  busy: boolean;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const ctx = useContext(ChatActionsContext);
  if (!ctx) throw new Error("useChatActions must be used within ChatActionsContext.Provider");
  return ctx;
}

/** messages 中 userMessageId 之后紧邻的 assistant 消息 id（无则 undefined）。 */
export function nextAssistantId(
  messages: ChatUIMessage[],
  userMessageId: string,
): string | undefined {
  const i = messages.findIndex((m) => m.id === userMessageId);
  if (i < 0) return undefined;
  const next = messages[i + 1];
  return next?.role === "assistant" ? next.id : undefined;
}
```

- [ ] **Step 4: 跑确认通过** — `pnpm test src/renderer/ai/chat-actions.test.ts` → PASS。

- [ ] **Step 5: transport 加 resend 分支** — `src/renderer/ai/ipc-chat-transport.ts` 的 `sendMessages`：签名加 `trigger`，在解析 book/conversation 后分流。完整替换 `sendMessages` 体：

```ts
    async sendMessages({ messages, abortSignal, trigger }) {
      const { currentBookId, readingContext } = useNavigationStore.getState();
      if (!currentBookId) {
        const { default: i18n } = await import("@renderer/i18n");
        throw new Error(i18n.t("ai.noBookToSend", "没有正在阅读的书，无法发送。"));
      }
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      if (trigger === "regenerate-assistant-message") {
        // 重发/编辑/再生成：目标 user 轮 = messages.at(-1)（regenerate 已移除其后 assistant）
        const conversationId = getActiveConversationId();
        if (!conversationId || !last) {
          void stream.cancel();
          const { default: i18n } = await import("@renderer/i18n");
          throw new Error(i18n.t("ai.noBookToSend", "没有正在阅读的书，无法发送。"));
        }
        const ack = await window.api.ai.resend({
          streamId,
          conversationId,
          userMessageId: last.id,
          userText,
        });
        if (!ack.ok) {
          void stream.cancel();
          throw new Error(ack.reason);
        }
        return stream;
      }

      // 新发：保证会话存在（无 active → 懒建）
      let conversationId = getActiveConversationId();
      if (!conversationId) {
        const convo = await window.api.chat.conversations.create({ bookId: currentBookId });
        useChatStore.getState().setActiveConversation(convo.id);
        conversationId = convo.id;
      }
      const chips = (last?.metadata?.contextChips ?? []).filter((c) => c.state !== "off");
      const ack = await window.api.ai.send({
        streamId,
        bookId: currentBookId,
        conversationId,
        chips,
        userText,
        readingContext,
      });
      if (!ack.ok) {
        void stream.cancel();
        throw new Error(ack.reason);
      }
      return stream;
    },
```

- [ ] **Step 6: AIPanel 接线**（`src/renderer/ai/AIPanel.tsx`）：
  1. import：`import { flushSync } from "react-dom";`、`import { ChatActionsContext, nextAssistantId, type ChatActions } from "@renderer/ai/chat-actions";`、从 useChat 解构追加 `regenerate`：`const { messages, sendMessage, status, stop, setMessages, regenerate, error } = useChat<ChatUIMessage>({...});`
  2. 构造 actions（放在 `handleSend` 附近）：

```tsx
const actions: ChatActions = {
  regenerate: (a) => void regenerate({ messageId: a.id }),
  resend: (u) => {
    const aId = nextAssistantId(messages, u.id);
    void regenerate(aId ? { messageId: aId } : undefined);
  },
  editAndResend: (u, newText) => {
    flushSync(() =>
      setMessages((ms) =>
        ms.map((m) => (m.id === u.id ? { ...m, parts: [{ type: "text", text: newText }] } : m)),
      ),
    );
    const aId = nextAssistantId(messages, u.id);
    void regenerate(aId ? { messageId: aId } : undefined);
  },
  busy: status === "streaming" || status === "submitted",
};
```

3. 轮结束从 DB 重载同步 id——改现有 status effect（约 :68-73）为：

```tsx
useEffect(() => {
  if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    const cid =
      useChatStore.getState().activeByBook[useNavigationStore.getState().currentBookId ?? ""] ??
      null;
    // 用闭包外的 activeConversationId 亦可；这里直接读 store 避免 effect 依赖膨胀
    const activeId = activeConversationId;
    if (activeId) {
      void window.api.chat.messages
        .listByConversation({ conversationId: activeId })
        .then((dtos) => setMessages(messagesToUI(dtos)))
        .catch((err: unknown) => log.warn("reload conversation after turn failed", err));
    }
  }
  prevStatus.current = status;
}, [status, qc, activeConversationId, setMessages]);
```

> 说明：`activeConversationId` 已在组件作用域（`useActiveConversationId()`）。删掉上面示例里多余的 `cid` 行——只用 `activeConversationId`。最终只保留：失效查询 + 若 `activeConversationId` 非空则重载并 `setMessages`。4. 用 Provider 包住 MessageList：

```tsx
<ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
  <div className="p-4">
    <ChatActionsContext.Provider value={actions}>
      <MessageList messages={messages} status={status} bookId={bookId} />
    </ChatActionsContext.Provider>
  </div>
</ScrollArea>
```

- [ ] **Step 7: typecheck + lint + 渲染层测试** — `pnpm typecheck && pnpm lint && pnpm test src/renderer/ai` → 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/ai/ipc-chat-transport.ts src/renderer/ai/chat-actions.ts src/renderer/ai/chat-actions.test.ts src/renderer/ai/AIPanel.tsx
git commit -m "$(cat <<'EOF'
feat(ai): wire resend/regenerate transport and chat actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: MessageToolbar 扩展 + UserBubble 就地编辑 + i18n

**Files:** `src/renderer/ai/MessageToolbar.tsx`(改)、`src/renderer/ai/MessageEditor.tsx`(新)、`src/renderer/ai/MessageList.tsx`(改)、`src/shared/i18n/locales/{zh-CN,en}.ts`(改)

- [ ] **Step 1: 扩展 `MessageToolbar.tsx`**（保留 #67 的 Copy；按 role 加按钮）：

```tsx
import { Pencil, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { CopyButton } from "@renderer/ai/CopyButton";
import { useChatActions } from "@renderer/ai/chat-actions";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡下方 hover/focus 揭示的动作行。Copy(#67) + 按 role 的 Edit/Resend/Regenerate。 */
export function MessageToolbar({ m, onEdit }: { m: ChatUIMessage; onEdit?: () => void }) {
  const { t } = useTranslation();
  const actions = useChatActions();
  return (
    <div
      role="toolbar"
      aria-label={t("ai.messageActions", "消息操作")}
      className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <CopyButton text={textOf(m)} />
      {m.role === "user" && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ai.edit", "编辑")}
            onClick={onEdit}
            disabled={actions.busy}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ai.resend", "重新发送")}
            onClick={() => actions.resend(m)}
            disabled={actions.busy}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </>
      )}
      {m.role === "assistant" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("ai.regenerate", "重新生成")}
          onClick={() => actions.regenerate(m)}
          disabled={actions.busy}
          className="text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 创建 `MessageEditor.tsx`**：

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";

/** user 消息就地编辑：textarea + 保存/取消。Enter 保存、Shift+Enter 换行、Esc 取消。 */
export function MessageEditor({
  initialText,
  busy,
  onSave,
  onCancel,
}: {
  initialText: string;
  busy: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 挂载时聚焦并把光标置末尾（命令式，React Compiler 不接管 effect 清理/聚焦）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && !busy;
  const save = () => {
    if (canSave) onSave(trimmed);
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-background p-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={3}
        className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("ai.editCancel", "取消")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {t("ai.editSave", "发送")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: UserBubble 编辑态**（`src/renderer/ai/MessageList.tsx`）。文件顶部 import 增补：`import { useState } from "react";`、`import { useChatActions } from "@renderer/ai/chat-actions";`、`import { MessageEditor } from "@renderer/ai/MessageEditor";`。把 `UserBubble` 改为：

```tsx
function UserBubble({ m }: { m: ChatUIMessage }) {
  const { t } = useTranslation();
  const actions = useChatActions();
  const [editing, setEditing] = useState(false);
  const chips = m.metadata?.contextChips ?? [];

  if (editing) {
    return (
      <div className="flex flex-col items-end">
        <div className="w-full max-w-[88%]">
          <MessageEditor
            initialText={textOf(m)}
            busy={actions.busy}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              setEditing(false);
              actions.editAndResend(m, text);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground">
        {chips.length > 0 && (
          <div className="mb-2 space-y-1.5 border-b border-primary-foreground/20 pb-2">
            {chips.map((c) => (
              <div key={c.id} className="rounded-md bg-primary-foreground/10 px-2 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground/70">
                  <span>{chipLabel(c)}</span>
                  <span className="tabular-nums">
                    ≈{c.tokenCount} {t("ai.tokUnit", "tok")}
                  </span>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-snug text-primary-foreground/90">
                  {c.content}
                </p>
              </div>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{textOf(m)}</div>
      </div>
      <MessageToolbar m={m} onEdit={() => setEditing(true)} />
    </div>
  );
}
```

（即在 #67 版 UserBubble 基础上：加 `actions`/`editing` 状态、编辑态分支、给 `<MessageToolbar>` 传 `onEdit`。气泡内 chips+正文不变。）AssistantBubble 不改（其 `<MessageToolbar m={m} />` 已由扩展后的组件自动渲染 Regenerate）。

- [ ] **Step 4: i18n** — `pnpm i18n:extract`，确认 zh-CN.ts 新增 `ai.edit/ai.editCancel/ai.editSave/ai.regenerate/ai.resend`；en.ts 留空串。自查 diff 仅这些键。

- [ ] **Step 5: 填英文** — `src/shared/i18n/locales/en.ts`：

```ts
  "ai.edit": "Edit",
  "ai.editCancel": "Cancel",
  "ai.editSave": "Send",
  "ai.regenerate": "Regenerate",
  "ai.resend": "Resend",
```

- [ ] **Step 6: typecheck + lint + i18n:lint + 测试** — `pnpm i18n:lint ; pnpm typecheck && pnpm lint && pnpm test src/renderer/ai` → typecheck/lint/test 全绿；i18n:lint 仅剩 3 个既存错误（无本特性键）。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/ai/MessageToolbar.tsx src/renderer/ai/MessageEditor.tsx src/renderer/ai/MessageList.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "$(cat <<'EOF'
feat(ai): edit/resend/regenerate actions on message bubbles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: changeset + 终验

**Files:** `.changeset/edit-resend-messages.md`(新)

- [ ] **Step 1: 写 changeset**：

```md
---
"marginalia": patch
---

Edit, resend, and regenerate AI chat messages. Hover a message in the AI panel to reveal actions: edit one of your earlier questions and resend it, resend it unchanged, or regenerate the assistant's reply. The conversation is truncated from that point and a fresh reply is streamed — useful for rephrasing, retrying a failed reply, or getting an alternative answer.
```

- [ ] **Step 2: 全量自动门** — `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` → 全绿（670+ 测试）。`pnpm i18n:lint` 仅 3 个既存失败。

- [ ] **Step 3: 提交**

```bash
git add .changeset/edit-resend-messages.md
git commit -m "$(cat <<'EOF'
chore: changeset for edit/resend chat messages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: dev CDP 冒烟（目视）** — `pnpm start`（`--user-data-dir` 隔离）+ CDP：① user 气泡 hover→Edit/Resend 现、assistant→Regenerate 现；② Edit→textarea 预填→改字→发送→其后消息消失、流式出新回复反映新问；③ Resend→原问重跑替换回复；④ assistant Regenerate→换答案；⑤ 流式中三类按钮禁用；⑥ 编辑后重开会话→持久内容为编辑后；⑦ 截断跨摘要边界旧消息重发→不报错。冒烟通过即完成；交付收尾走 `finishing-a-development-branch`（栈式 PR base=feat/copy-ai-chat-messages，body 注明依赖 #67/#71，`Closes #60`）。

---

## Self-Review（计划自查）

- **Spec coverage**：编辑重发→Task5 UserBubble 编辑+Task4 editAndResend+Task3 runResend；直接重发/再生成→Task5 Resend/Regenerate 按钮+Task4 actions+Task3 runResend；截断+摘要重置→Task1 resetUserTurnForResend；id 同步→Task4 Step6.3 重载；trigger 路由→Task4 Step5；chips 用快照→Task2 assemblePrompt 放宽 + Task3 current 取 metadata 快照；并发禁用→Task5 disabled=actions.busy；IPC→Task3 Step5-6。全覆盖。
- **Placeholder**：无 TBD；每步含完整代码。`freshConvoDb` async 已在 Task1 注明改 `await`。
- **Type consistency**：`streamAssistantReply(deps,ctx,messages,systemPrompt,opts)`→`OkSendResult` 在 Task2 定义、Task3 runResend 同签名调用；`SendResult=OkSendResult|{ok:false}`；`ResendInput{conversationId,userMessageId,userText}` 在 chat.ts(Task3 Step5) 定义、runResend(Task3 Step3)/transport(Task4 Step5)/IPC(Task3 Step6) 一致；`ChatActions{resend,editAndResend,regenerate,busy}` Task4 定义、Task5 消费一致；`nextAssistantId(messages,id)` Task4 定义+用。
- **YAGNI**：复用 #67 MessageToolbar + runSend 尾段；统一一个 ai:resend 覆盖三入口；不造分支/fork/动作注册表。
- **风险点**：`regenerate({messageId: userMessageId})`（resend 当无 next assistant 时走 `regenerate()` 无参，仅再生成末条/末 user 轮）——已避免依赖 regenerate 接受 user id；编辑文本同步靠 flushSync。若实现中发现 `regenerate()` 行为与预期不符，subagent 应取证（transport 收到的 messages/trigger）后报告。

```

```
