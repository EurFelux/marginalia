# 竖切 Plan 1 · 主进程补口（M-p + M-a）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主进程/preload 接通流式 IPC transport（`ai:send`/`ai:abort`/`ai:chunk`）并闭合竖切所需的 typed `window.api`，让渲染层有真实的数据与流式入口。

**Architecture:** `ai:send`（invoke）校验 `SendRequest` Zod → `makeSendDeps()` 组装 `runSend` 依赖 → `runSend` 返回 `{stream, finished}` → 后台 `pumpStream` 把 `UIMessageChunk` 经 `webContents.send('ai:chunk')` 逐块推回，渲染层铸的 `streamId` 解复用；`ai:abort` 经 per-stream `AbortController` 中断 `streamText`。`SendInput` 的 Zod 单源落在 `@shared/chat`；`preload` 按领域暴露全量 typed API。

**Tech Stack:** Electron 42（ipcMain/contextBridge/webContents/safeStorage）、Zod 4、Vercel AI SDK v6（`UIMessageChunk`/`streamText`）、vitest 4（Node ABI，`:memory:` SQLite + `MockLanguageModelV3`）。

**上游 spec:** `docs/superpowers/specs/2026-06-01-marginalia-vertical-slice-design.md` §4（M-a）、§5（M-p）。

---

## 关键现状（勘察确认，实现时无需再查）

- `runSend(deps: SendDeps, input: SendInput): SendResult`（`src/main/ai/send.ts:62`），同步返回 `{ ok:true, conversationId, created, switchedFromActive, stream: AsyncIterable<UIMessageChunk>, finished: Promise<void> } | { ok:false, reason }`。
- `streamText({ model, system, messages, tools, stopWhen })`（`send.ts:126–132`）**当前未传 `abortSignal`**；`onFinish`（`send.ts:153–162`）仅在 `!isAborted && !streamHadError` 时 `appendMessage` 落库。
- `SendInput` 现为 `send.ts:16–22` 手写 interface；`SendDeps`（`send.ts:24–35`）= `{ db, loadBytes, resolveModel, ensureSummary, stepLimit? }`。
- `handle<I,O>(channel, schema, handler)`（`src/main/ipc/registry.ts:6–20`）当前 `handler: (input)=>O|Promise<O>`，内部 `ipcMain.handle(channel, async (_event, raw)=>...)`——`_event` 已接收但未用。
- `validateInput(channel, schema, raw)`（`src/main/ipc/validate.ts:4–13`）。
- `resolveAssistantModel(db, encryptor): ResolvedModel`（`src/main/ai/assistant-model.ts:13`），`ResolvedModel = {ok:true,model,modelId} | {ok:false,reason}`（`:8–10`）。
- `safeStorageEncryptor: Encryptor`（`src/main/secrets/safe-storage-encryptor.ts:5`），`Encryptor={isAvailable,encrypt,decrypt}`（`src/main/secrets/encryptor.ts:2`）。
- `getBook(db, id): BookRow | undefined`（`src/main/library/repository.ts:65`），`BookRow.path:string`。
- `ensureChapterSummary(deps: SummaryDeps, bookId, chapterId): Promise<void>`（`src/main/ai/summary.ts:25`），`SummaryDeps={db,loadBytes,resolveModel}`（`:15–19`）。
- `LoadBytes=(bookId)=>Promise<Uint8Array>`（`src/main/ai/tools.ts:8`）；`getDb()`（`@main/db/instance`）。
- `chat.ts` 已有 `chipSchema`（`src/shared/chat.ts:8–17`）、`import { z }`、`import type { UIMessage } from "ai"`。
- preload 现仅暴露 `app.getInfo`/`ping`（`src/preload.ts`）；preload vite config 已配 `@shared` 别名。
- main.ts `app.on("ready")` 顺序注册 `registerAppHandlers/registerLibraryHandlers/registerSettingsHandlers/registerChatHandlers`（`src/main.ts:47–60`）。

## File Structure

| 文件                               | 动作 | 职责                                                                                       |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `src/shared/ipc.ts`                | 改   | `IPC` 加 `aiSend`/`aiAbort`/`aiChunk` 通道名                                               |
| `src/shared/chat.ts`               | 改   | 新增 `sendInputSchema`/`sendRequest`/`sendAck`/`abortInput` + `AiStreamEvent` 类型         |
| `src/shared/chat.test.ts`          | 改   | 新增上述 schema 的校验测试                                                                 |
| `src/main/ai/send.ts`              | 改   | `SendInput` 改 import 自 `@shared/chat`；`runSend` 加 `opts.abortSignal` 透传 `streamText` |
| `src/main/ai/send.test.ts`         | 改   | 加「透传 abortSignal 不破坏正常路径」测试                                                  |
| `src/main/ipc/registry.ts`         | 改   | `handle` 的 handler 加第二参 `event: IpcMainInvokeEvent`（向后兼容）                       |
| `src/main/ai/send-deps.ts`         | 建   | `makeSendDeps()` 生产工厂 + 可测的 `createLoadBytes(db)`                                   |
| `src/main/ai/send-deps.test.ts`    | 建   | `createLoadBytes` 的读取/缺书测试                                                          |
| `src/main/ipc/ai-handlers.ts`      | 建   | `registerAiHandlers()` + 可测的 `pumpStream()`                                             |
| `src/main/ipc/ai-handlers.test.ts` | 建   | `pumpStream` 的 chunk/finish/error/abort 事件序列测试                                      |
| `src/main.ts`                      | 改   | `app.on("ready")` 注册 `registerAiHandlers()`                                              |
| `src/preload.ts`                   | 改   | 按领域暴露全量 typed `window.api`（library/content/settings/chat/ai）                      |

> 无新增 npm 依赖（`uuid` 已在根；zustand/react-query 属 Plan 2/3 的渲染层）。

---

## Task 1：shared 契约（通道名 + Zod 单源）

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/chat.ts`
- Test: `src/shared/chat.test.ts`

- [ ] **Step 1：在 `src/shared/ipc.ts` 的 `IPC` 对象末尾（`aiBuildChips` 行后）加 3 个通道名**

```ts
  aiBuildChips: "ai:build-chips",
  aiSend: "ai:send",
  aiAbort: "ai:abort",
  aiChunk: "ai:chunk",
} as const;
```

- [ ] **Step 2：在 `src/shared/chat.ts` 顶部 import 补 `UIMessageChunk`**

把现有 `import type { UIMessage } from "ai";` 改为：

```ts
import type { UIMessage, UIMessageChunk } from "ai";
```

- [ ] **Step 3：在 `src/shared/chat.ts` 末尾（`MessageDto` interface 之后）追加流式契约**

```ts
/** runSend 的业务入参（不含传输层 streamId）。取代 send.ts 中手写的 SendInput interface。 */
export const sendInputSchema = z.object({
  bookId: z.string().min(1),
  currentChapterId: z.string().min(1),
  activeConversationId: z.string().min(1).nullable(),
  chips: z.array(chipSchema),
  userText: z.string().min(1),
});
export type SendInput = z.infer<typeof sendInputSchema>;

/** ai:send 入站载体 = 业务入参 + 渲染层铸的 streamId。 */
export const sendRequest = sendInputSchema.extend({ streamId: z.string().min(1) });
export type SendRequest = z.infer<typeof sendRequest>;

/** ai:send invoke 的同步 ack（增量走 ai:chunk 事件流，故不含 stream/finished）。 */
export const sendAck = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    conversationId: z.string(),
    created: z.boolean(),
    switchedFromActive: z.boolean(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SendAck = z.infer<typeof sendAck>;

/** ai:abort 入参。 */
export const abortInput = z.object({ streamId: z.string().min(1) });
export type AbortInput = z.infer<typeof abortInput>;

/** ai:chunk 出站事件（main→renderer，不 Zod；UIMessageChunk 为 AI SDK 复杂联合）。 */
export type AiStreamEvent =
  | { streamId: string; type: "chunk"; chunk: UIMessageChunk }
  | { streamId: string; type: "finish" }
  | { streamId: string; type: "error"; message: string };
```

- [ ] **Step 4：在 `src/shared/chat.test.ts` 追加 schema 测试**

```ts
import { sendRequest, sendAck, abortInput } from "@shared/chat";

describe("sendRequest", () => {
  const base = {
    streamId: "s1",
    bookId: "b1",
    currentChapterId: "c1",
    activeConversationId: null,
    chips: [],
    userText: "hi",
  };
  it("accepts a valid request with empty chips and null conversation", () => {
    expect(sendRequest.safeParse(base).success).toBe(true);
  });
  it("rejects empty userText", () => {
    expect(sendRequest.safeParse({ ...base, userText: "" }).success).toBe(false);
  });
  it("rejects missing streamId", () => {
    const { streamId: _omit, ...rest } = base;
    expect(sendRequest.safeParse(rest).success).toBe(false);
  });
});

describe("sendAck", () => {
  it("accepts ok:true variant", () => {
    expect(
      sendAck.safeParse({ ok: true, conversationId: "c", created: true, switchedFromActive: false })
        .success,
    ).toBe(true);
  });
  it("accepts ok:false variant", () => {
    expect(sendAck.safeParse({ ok: false, reason: "no key" }).success).toBe(true);
  });
});

describe("abortInput", () => {
  it("rejects empty streamId", () => {
    expect(abortInput.safeParse({ streamId: "" }).success).toBe(false);
  });
});
```

> `src/shared/chat.test.ts` 已存在并已 import `describe/it/expect`（vitest globals）。若顶部尚无 `import` 这些 schema，按上方补；沿用文件现有的 describe 块风格。

- [ ] **Step 5：跑测试确认通过**

Run: `pnpm test src/shared/chat.test.ts`
Expected: 新增的 `sendRequest`/`sendAck`/`abortInput` 用例全 PASS。

- [ ] **Step 6：提交**

```bash
git add src/shared/ipc.ts src/shared/chat.ts src/shared/chat.test.ts
git commit -m "feat(ipc): add ai:send/abort/chunk channels and streaming Zod contracts"
```

---

## Task 2：`send.ts` 切到 shared `SendInput` + `runSend` 接 abortSignal

**Files:**

- Modify: `src/main/ai/send.ts:14`（import）、`:16-22`（删 interface）、`:62`（签名）、`:126-132`（streamText）
- Test: `src/main/ai/send.test.ts`

- [ ] **Step 1：先写新测试（在 `src/main/ai/send.test.ts` 的 `describe("runSend")` 内追加）**

```ts
it("forwards a non-aborted signal without breaking the normal persist path", async () => {
  const controller = new AbortController();
  const { db, deps } = setup({ ok: true, model: textStreamModel("hello"), modelId: "mock" });
  const r = runSend(deps, input("explain this"), { abortSignal: controller.signal });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  await r.finished;
  // 正常路径：user + assistant 两条都落库
  expect(listMessages(db, r.conversationId)).toHaveLength(2);
});
```

> 复用该测试文件已有的 `setup()` / `textStreamModel()` / `input()` / `listMessages` helper（见文件上方）。`input(text)` 若签名不同，按文件现有用法传参。

- [ ] **Step 2：跑测试确认失败**

Run: `pnpm test src/main/ai/send.test.ts -t "forwards a non-aborted signal"`
Expected: FAIL —— 类型错误「runSend 期望 2 个参数」或运行期忽略第三参。

- [ ] **Step 3：改 `send.ts` import（第 14 行附近）**

把 `import type { Chip } from "@shared/chat";` 改为：

```ts
import { type SendInput } from "@shared/chat";
```

（若 `Chip` 在文件他处仍被引用则保留：`import { type Chip, type SendInput } from "@shared/chat";`；oxlint 会标未用 import，按提示删。）

- [ ] **Step 4：删除 `send.ts:16-22` 手写的 `SendInput` interface**

删除整段：

```ts
export interface SendInput {
  bookId: string;
  currentChapterId: string;
  activeConversationId: string | null;
  chips: Chip[];
  userText: string;
}
```

- [ ] **Step 5：`runSend` 签名加可选 `opts` 并把 `abortSignal` 透传给 `streamText`**

签名（`send.ts:62`）：

```ts
export function runSend(
  deps: SendDeps,
  input: SendInput,
  opts?: { abortSignal?: AbortSignal },
): SendResult {
```

`streamText` 调用（`send.ts:126-132`）加一行 `abortSignal`：

```ts
const result = streamText({
  model: resolved.model,
  system: systemPrompt,
  messages,
  tools,
  stopWhen: stepCountIs(stepLimit ?? 5),
  abortSignal: opts?.abortSignal,
});
```

> 落库语义不变：现有 `onFinish` 已据 `isAborted` 决定是否 `appendMessage`，abort 时自然不落库。

- [ ] **Step 6：跑测试确认通过（含原有用例不回归）**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: 全 PASS（新用例 + 原有用例）。

- [ ] **Step 7：提交**

```bash
git add src/main/ai/send.ts src/main/ai/send.test.ts
git commit -m "feat(ai): source SendInput from shared and thread abortSignal into runSend"
```

---

## Task 3：`registry.handle` 让 handler 拿到 `IpcMainInvokeEvent`

**Files:**

- Modify: `src/main/ipc/registry.ts`

- [ ] **Step 1：改写 `src/main/ipc/registry.ts` 全文**

```ts
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";

/**
 * 注册一个经 Zod 校验的 invoke handler。
 * handler 第二参为 IpcMainInvokeEvent（流式通道需要 event.sender）；不需要的 handler 忽略即可。
 */
export function handle<I, O>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I, event: IpcMainInvokeEvent) => O | Promise<O>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      const input = validateInput(channel, inputSchema, raw);
      return await handler(input, event);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      throw err;
    }
  });
}
```

> 这是向后兼容的拓宽：现有所有 `handle(ch, schema, (input) => ...)` 调用因 JS 实参可少于形参而**不受影响**，类型上也兼容（少声明一个参数合法）。`import` 行如与现状不同，以现状的 `import { ipcMain } from "electron"` 为基础，仅补 `type IpcMainInvokeEvent`。

- [ ] **Step 2：typecheck + 跑既有 IPC 相关测试确认不回归**

Run: `pnpm typecheck && pnpm test src/shared/ipc.test.ts`
Expected: typecheck 0 错；既有测试 PASS。

- [ ] **Step 3：提交**

```bash
git add src/main/ipc/registry.ts
git commit -m "feat(ipc): expose IpcMainInvokeEvent to handlers (backward compatible)"
```

---

## Task 4：`makeSendDeps()` 生产工厂

**Files:**

- Create: `src/main/ai/send-deps.ts`
- Test: `src/main/ai/send-deps.test.ts`

- [ ] **Step 1：写失败测试 `src/main/ai/send-deps.test.ts`（测可注入的 `createLoadBytes`）**

```ts
import { describe, expect, it, vi } from "vitest";
import { createLoadBytes } from "@main/ai/send-deps";
import type { DB } from "@main/db/client";

const fakeDb = (path: string | null) =>
  ({
    /* 仅供 getBook 经由 select().from().where().get() 使用，见下方 mock */
  }) as unknown as DB;

vi.mock("@main/library/repository", () => ({
  getBook: (_db: unknown, id: string) =>
    id === "known" ? { id, path: "/tmp/marginalia-test.epub" } : undefined,
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
}));

describe("createLoadBytes", () => {
  it("reads bytes for a known book", async () => {
    const loadBytes = createLoadBytes(fakeDb("/tmp/marginalia-test.epub"));
    const bytes = await loadBytes("known");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
  it("throws for an unknown book", async () => {
    const loadBytes = createLoadBytes(fakeDb(null));
    await expect(loadBytes("missing")).rejects.toThrow(/missing/);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `pnpm test src/main/ai/send-deps.test.ts`
Expected: FAIL —— `createLoadBytes` 未定义。

- [ ] **Step 3：实现 `src/main/ai/send-deps.ts`**

```ts
import { readFile } from "node:fs/promises";
import type { DB } from "@main/db/client";
import { getDb } from "@main/db/instance";
import { getBook } from "@main/library/repository";
import { safeStorageEncryptor } from "@main/secrets/safe-storage-encryptor";
import { resolveAssistantModel } from "@main/ai/assistant-model";
import { ensureChapterSummary, type SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";

/** (bookId) => 该书 ePub 原始字节；book 不存在则抛。可注入 db 以便单测。 */
export function createLoadBytes(db: DB): LoadBytes {
  return async (bookId: string) => {
    const book = getBook(db, bookId);
    if (!book) throw new Error(`send-deps: book ${bookId} not found`);
    const buf = await readFile(book.path);
    return new Uint8Array(buf);
  };
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(db);
  const resolveModel = () => resolveAssistantModel(db, safeStorageEncryptor);
  const summaryDeps: SummaryDeps = { db, loadBytes, resolveModel };
  const ensureSummary = (bookId: string, chapterId: string): void => {
    // fire-and-forget：自含 reject，杜绝 unhandledRejection
    void ensureChapterSummary(summaryDeps, bookId, chapterId).catch((err) => {
      console.warn("[send-deps] ensureChapterSummary failed:", err);
    });
  };
  return { db, loadBytes, resolveModel, ensureSummary };
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `pnpm test src/main/ai/send-deps.test.ts`
Expected: 两个用例 PASS。

- [ ] **Step 5：提交**

```bash
git add src/main/ai/send-deps.ts src/main/ai/send-deps.test.ts
git commit -m "feat(ai): add makeSendDeps production factory"
```

---

## Task 5：`ai-handlers.ts`（`registerAiHandlers` + `pumpStream`）

**Files:**

- Create: `src/main/ipc/ai-handlers.ts`
- Test: `src/main/ipc/ai-handlers.test.ts`

- [ ] **Step 1：写失败测试 `src/main/ipc/ai-handlers.test.ts`（测 `pumpStream` 事件序列）**

```ts
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc";
import { pumpStream } from "@main/ipc/ai-handlers";
import type { SendResult } from "@main/ai/send";

type OkResult = Extract<SendResult, { ok: true }>;

function okResult(chunks: unknown[], finished = Promise.resolve()): OkResult {
  async function* gen() {
    for (const c of chunks) yield c as never;
  }
  return {
    ok: true,
    conversationId: "conv-1",
    created: true,
    switchedFromActive: false,
    stream: gen(),
    finished,
  };
}

function fakeSender() {
  return { isDestroyed: () => false, send: vi.fn() };
}

describe("pumpStream", () => {
  it("emits chunk* then finish", async () => {
    const sender = fakeSender();
    await pumpStream(
      sender,
      "s1",
      okResult([{ type: "x" }, { type: "y" }]),
      new AbortController().signal,
    );
    expect(sender.send.mock.calls).toEqual([
      [IPC.aiChunk, { streamId: "s1", type: "chunk", chunk: { type: "x" } }],
      [IPC.aiChunk, { streamId: "s1", type: "chunk", chunk: { type: "y" } }],
      [IPC.aiChunk, { streamId: "s1", type: "finish" }],
    ]);
  });

  it("emits error when the stream throws (not aborted)", async () => {
    const sender = fakeSender();
    async function* boom() {
      yield { type: "x" } as never;
      throw new Error("boom");
    }
    const result = { ...okResult([]), stream: boom() } as OkResult;
    await pumpStream(sender, "s2", result, new AbortController().signal);
    const calls = sender.send.mock.calls;
    expect(calls.at(-1)).toEqual([IPC.aiChunk, { streamId: "s2", type: "error", message: "boom" }]);
  });

  it("emits finish (not error) when aborted mid-stream", async () => {
    const sender = fakeSender();
    const controller = new AbortController();
    async function* boom() {
      yield { type: "x" } as never;
      controller.abort();
      throw new Error("aborted by signal");
    }
    const result = { ...okResult([]), stream: boom() } as OkResult;
    await pumpStream(sender, "s3", result, controller.signal);
    expect(sender.send.mock.calls.at(-1)).toEqual([
      IPC.aiChunk,
      { streamId: "s3", type: "finish" },
    ]);
  });

  it("does not send to a destroyed sender", async () => {
    const sender = { isDestroyed: () => true, send: vi.fn() };
    await pumpStream(sender, "s4", okResult([{ type: "x" }]), new AbortController().signal);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `pnpm test src/main/ipc/ai-handlers.test.ts`
Expected: FAIL —— `pumpStream` 未定义。

- [ ] **Step 3：实现 `src/main/ipc/ai-handlers.ts`**

```ts
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "@shared/ipc";
import {
  abortInput,
  sendRequest,
  type AbortInput,
  type AiStreamEvent,
  type SendAck,
  type SendRequest,
} from "@shared/chat";
import { handle } from "@main/ipc/registry";
import { runSend, type SendResult } from "@main/ai/send";
import { makeSendDeps } from "@main/ai/send-deps";

type StreamSender = Pick<WebContents, "send" | "isDestroyed">;

/** 把 runSend 的 UIMessageChunk 流逐块经 ai:chunk 推回渲染层；abort 视为正常收尾。 */
export async function pumpStream(
  sender: StreamSender,
  streamId: string,
  result: Extract<SendResult, { ok: true }>,
  signal: AbortSignal,
): Promise<void> {
  const emit = (ev: AiStreamEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC.aiChunk, ev);
  };
  try {
    for await (const chunk of result.stream) {
      if (signal.aborted) break;
      emit({ streamId, type: "chunk", chunk });
    }
    await result.finished;
    emit({ streamId, type: "finish" });
  } catch (err) {
    if (signal.aborted) emit({ streamId, type: "finish" });
    else
      emit({ streamId, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

const controllers = new Map<string, AbortController>();

export function registerAiHandlers(): void {
  handle<SendRequest, SendAck>(IPC.aiSend, sendRequest, (req, event: IpcMainInvokeEvent) => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    controllers.set(streamId, controller);

    const result = runSend(makeSendDeps(), input, { abortSignal: controller.signal });
    if (!result.ok) {
      controllers.delete(streamId);
      return { ok: false, reason: result.reason };
    }
    void pumpStream(event.sender, streamId, result, controller.signal).finally(() => {
      controllers.delete(streamId);
    });
    return {
      ok: true,
      conversationId: result.conversationId,
      created: result.created,
      switchedFromActive: result.switchedFromActive,
    };
  });

  handle<AbortInput, void>(IPC.aiAbort, abortInput, ({ streamId }) => {
    controllers.get(streamId)?.abort();
  });
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `pnpm test src/main/ipc/ai-handlers.test.ts`
Expected: 4 个用例全 PASS。

- [ ] **Step 5：提交**

```bash
git add src/main/ipc/ai-handlers.ts src/main/ipc/ai-handlers.test.ts
git commit -m "feat(ipc): add ai:send/ai:abort handlers with streaming pump"
```

---

## Task 6：在 `main.ts` 注册 `registerAiHandlers`

**Files:**

- Modify: `src/main.ts:47-60`

- [ ] **Step 1：import + 在 ready 回调里注册**

在 `src/main.ts` 顶部 import 区（与其他 `registerXHandlers` import 同处）加：

```ts
import { registerAiHandlers } from "@main/ipc/ai-handlers";
```

在 `app.on("ready")` 的 `registerChatHandlers();` 之后加：

```ts
registerChatHandlers();
registerAiHandlers();
```

> import 路径以文件现有 `registerChatHandlers` 的写法为准（相对 `./ipc/...` 或 `@main/ipc/...`，保持一致）。

- [ ] **Step 2：typecheck**

Run: `pnpm typecheck`
Expected: 0 错。

- [ ] **Step 3：提交**

```bash
git add src/main.ts
git commit -m "feat(main): register ai streaming handlers on ready"
```

---

## Task 7：preload 闭合全量 typed `window.api`（M-p）

**Files:**

- Modify: `src/preload.ts`

- [ ] **Step 1：改写 `src/preload.ts` 全文**

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppGetInfoResult, type PingInput, type PingResult } from "@shared/ipc";
import type {
  BookIdInput,
  BookSummaryDto,
  ChapterTextSlice,
  ImportBookInput,
  ReadChapterTextInput,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import type {
  ProviderDto,
  ProviderIdInput,
  TestProviderInput,
  TestResult,
  UpsertProviderInput,
} from "@shared/providers";
import type { AssistantDto, UpdateAssistantInput } from "@shared/assistant";
import type {
  AbortInput,
  AiStreamEvent,
  BuildChipsInput,
  Chip,
  ConversationDto,
  MessageDto,
  MessagesByConversationInput,
  SendAck,
  SendRequest,
} from "@shared/chat";

const api = {
  app: {
    getInfo: (): Promise<AppGetInfoResult> => ipcRenderer.invoke(IPC.appGetInfo),
  },
  ping: (input: PingInput): Promise<PingResult> => ipcRenderer.invoke(IPC.ping, input),

  library: {
    import: (input: ImportBookInput): Promise<BookSummaryDto> =>
      ipcRenderer.invoke(IPC.libraryImport, input),
    list: (): Promise<BookSummaryDto[]> => ipcRenderer.invoke(IPC.libraryList),
    get: (input: BookIdInput): Promise<BookSummaryDto | null> =>
      ipcRenderer.invoke(IPC.libraryGet, input),
  },

  content: {
    toc: (input: BookIdInput): Promise<TocNode[]> => ipcRenderer.invoke(IPC.contentToc, input),
    chapterText: (input: ReadChapterTextInput): Promise<ChapterTextSlice> =>
      ipcRenderer.invoke(IPC.contentChapterText, input),
  },

  settings: {
    providers: {
      list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(IPC.providersList),
      upsert: (input: UpsertProviderInput): Promise<ProviderDto> =>
        ipcRenderer.invoke(IPC.providersUpsert, input),
      test: (input: TestProviderInput): Promise<TestResult> =>
        ipcRenderer.invoke(IPC.providersTest, input),
      remove: (input: ProviderIdInput): Promise<void> =>
        ipcRenderer.invoke(IPC.providersRemove, input),
    },
    assistant: {
      getDefault: (): Promise<AssistantDto> => ipcRenderer.invoke(IPC.assistantGetDefault),
      update: (input: UpdateAssistantInput): Promise<AssistantDto> =>
        ipcRenderer.invoke(IPC.assistantUpdate, input),
    },
  },

  chat: {
    conversations: {
      listByBook: (input: BookIdInput): Promise<ConversationDto[]> =>
        ipcRenderer.invoke(IPC.conversationsListByBook, input),
    },
    messages: {
      listByConversation: (input: MessagesByConversationInput): Promise<MessageDto[]> =>
        ipcRenderer.invoke(IPC.messagesListByConversation, input),
    },
  },

  ai: {
    buildChips: (input: BuildChipsInput): Promise<Chip[]> =>
      ipcRenderer.invoke(IPC.aiBuildChips, input),
    send: (input: SendRequest): Promise<SendAck> => ipcRenderer.invoke(IPC.aiSend, input),
    abort: (input: AbortInput): Promise<void> => ipcRenderer.invoke(IPC.aiAbort, input),
    /** 订阅本 streamId 的增量；返回退订函数。 */
    onChunk: (streamId: string, cb: (ev: AiStreamEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AiStreamEvent) => {
        if (payload.streamId === streamId) cb(payload);
      };
      ipcRenderer.on(IPC.aiChunk, listener);
      return () => ipcRenderer.removeListener(IPC.aiChunk, listener);
    },
  },
};

contextBridge.exposeInMainWorld("api", api);

export type RendererApi = typeof api;
```

> **DTO 位置核对**：`ChapterTextSlice`（`{text,hasMore,nextOffset}`）与 `BookSummaryDto` 须可从 `@shared/library` 导入；`TestResult` 从 `@shared/providers`。若 `ChapterTextSlice` 当前定义在主进程侧（如 `library-handlers.ts`），将其 **类型定义迁至 `src/shared/library.ts`** 并在主进程改为 import——M-p 契约要求 renderer 可消费的 DTO 都在 shared。其余类型（`ImportBookInput`/`BookIdInput`/`ReadChapterTextInput`/`Provider*`/`Assistant*`/`Conversation*`/`Message*`/`BuildChipsInput`/`Chip`）勘察已确认在对应 `@shared/*` 文件导出。

- [ ] **Step 2：typecheck（preload 无 headless 单测，靠类型把关）**

Run: `pnpm typecheck`
Expected: 0 错。若报某 DTO 找不到，按 Step 1 备注把该类型迁到 `@shared/*` 后重试。

- [ ] **Step 3：提交**

```bash
git add src/preload.ts src/shared/library.ts
git commit -m "feat(preload): expose typed window.api for library/content/settings/chat/ai"
```

---

## 全量验收（Plan 1 完成判据）

- [ ] `pnpm typecheck` 0 错。
- [ ] `pnpm lint` 0 错。
- [ ] `pnpm test` 全绿（含新增 chat schema / send abort / send-deps / ai-handlers 用例）。
- [ ] `window.api` 暴露 library/content/settings/chat/ai 全组，`ai.send` 返回 `SendAck`、`ai.onChunk` 返回退订函数。
- [ ] M-a 三通道（`ai:send`/`ai:abort`/`ai:chunk`）在主进程注册并经 Zod 校验入站、信任出站。

> Plan 1 是纯主进程/preload，端到端真流式要等 Plan 2（渲染层地基+读+设置）与 Plan 3（选区链+S4 打通）。
