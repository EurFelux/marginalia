# History Replay Tool-Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay assistant `tool-call`/`tool-result` pairs natively in conversation history so the model stops few-shot-imitating text-only flattened history and faking tool calls (#42).

**Architecture:** In `assemblePrompt`, assistant history turns are converted with the AI SDK's `convertToModelMessages` into real `assistant(text+tool-call)` + `tool(result)` ModelMessages, instead of being flattened to text via `textOfParts`. Cross-turn `reasoning` parts are stripped before conversion; `readPage` image tool-results are elided to a short placeholder; incomplete/orphan tool-calls are dropped via `ignoreIncompleteToolCalls`. Because `convertToModelMessages` is **async**, `assemblePrompt` and its callers (`runSend`/`runResend`, the two `ai:*` IPC binds) become async — a mechanical ripple landed atomically; the IPC layer already supports async handlers.

**Tech Stack:** TypeScript 6 (strict), Vercel AI SDK v6 (`ai`), Drizzle/better-sqlite3 (test DB `:memory:`), vitest 4 (headless on Electron runtime), oxlint/oxfmt.

---

## Spec Amendment (read first)

The approved spec (`docs/superpowers/specs/2026-06-09-history-replay-tool-parts-design.md`) assumed `convertToModelMessages` is synchronous and that `assemblePrompt` stays sync. Implementation probing proved it returns `Promise<ModelMessage[]>`. **Decision:** keep Approach A (SDK conversion — it correctly handles multi-step `step-start` boundaries, which a hand-rolled sync mapper would reorder) and make the call chain async. "Pure function" is preserved in the sense that matters (no Electron/DB deps, headless-testable); async is orthogonal. Task 4 records this amendment in the spec.

> **Why prompt.ts + send.ts + ai-handlers.ts land in one task:** making `assemblePrompt` async immediately breaks `send.ts` typecheck (`const allMessages: ModelMessage[] = assemblePrompt(...)` would assign a `Promise`). The async edit and every call site must commit together so each commit is green.

Probed ground truth (ai@6.0.193), so tasks below match real output shape:

- No `tools` option needed: `tool-readChapterText` part → `{type:"tool-call", toolName:"readChapterText", toolCallId, input, providerExecuted: undefined}` in the assistant message, and a separate `{role:"tool", content:[{type:"tool-result", toolCallId, toolName, output:{type:"json", value:<output>}}]}`.
- `reasoning` parts are emitted by default → must be filtered out before conversion.
- `ignoreIncompleteToolCalls: true` drops tool-calls lacking output (no throw).
- A text-only assistant turn becomes `{role:"assistant", content:[{type:"text", text}]}` (array content), **not** a bare string — existing assertions must update.

---

## File Structure

- `src/main/ai/prompt.ts` — **Modify.** Add logger + `assistantHistoryToModelMessages` + image elision helper; make `assemblePrompt` async; assistant branch of the history loop uses the new converter. `textOfParts`/`renderHistoryMessage`/`renderUserTurn` stay (used by fallback, compaction, user turns).
- `src/main/ai/send.ts` — **Modify.** `runSend`/`runResend` become async; `await assemblePrompt(...)`.
- `src/main/ipc/ai-handlers.ts` — **Modify.** The two `bind(...)` callbacks become async; `await runSend(...)`/`await runResend(...)`.
- `src/main/ai/prompt.test.ts` — **Modify.** Await `assemblePrompt`; update the text-assistant assertion to array content; add structured-replay / elision / reasoning-drop / orphan / fallback tests.
- `src/main/ai/send.test.ts` — **Modify.** `await runSend(...)`/`await runResend(...)` at all call sites (all `it` callbacks are already async).
- `.changeset/history-replay-tool-parts.md` — **Create.** User-facing changelog entry.
- Design spec — **Modify.** Append the async amendment note.

No new files, IPC channels, Zod schemas, or DB columns.

---

## Task 1: Async `assemblePrompt` + structured assistant replay (atomic across prompt/send/handlers)

**Files:**

- Modify: `src/main/ai/prompt.ts`
- Modify: `src/main/ai/send.ts` (headers at `:38`, `:122`; call sites `:93`, `:185`)
- Modify: `src/main/ipc/ai-handlers.ts` (`:82-96`, `:98-111`)
- Test: `src/main/ai/prompt.test.ts`, `src/main/ai/send.test.ts`

- [ ] **Step 1: Write the failing test (structured replay)**

Add inside the `describe("assemblePrompt", ...)` block in `src/main/ai/prompt.test.ts`:

```ts
it("replays an assistant tool-call/result turn as structured assistant + tool messages", async () => {
  const history: PromptHistoryMessage[] = [
    { role: "user", parts: [{ type: "text", text: "what's on page 3?" }], metadata: null },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Let me check." },
        {
          type: "tool-readChapterText",
          toolCallId: "c1",
          state: "output-available",
          input: { chapterId: "ch-1" },
          output: { text: "verbatim chapter text", hasMore: false },
        },
        { type: "text", text: "It discusses cats." },
      ] as PromptHistoryMessage["parts"],
      metadata: null,
    },
  ];
  const out = await assemblePrompt({
    systemPrompt: null,
    history,
    current: { chips: [], userText: "go on" },
  });
  const assistant = out.find((m) => m.role === "assistant");
  const toolMsg = out.find((m) => m.role === "tool");
  expect(assistant).toBeDefined();
  expect(toolMsg).toBeDefined();
  const aContent = assistant!.content as Array<{ type: string; toolName?: string; text?: string }>;
  expect(aContent.some((p) => p.type === "text" && p.text === "Let me check.")).toBe(true);
  expect(aContent.some((p) => p.type === "tool-call" && p.toolName === "readChapterText")).toBe(
    true,
  );
  const tContent = toolMsg!.content as Array<{ type: string; toolName?: string; output?: unknown }>;
  expect(tContent.some((p) => p.type === "tool-result" && p.toolName === "readChapterText")).toBe(
    true,
  );
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/main/ai/prompt.test.ts -t "replays an assistant tool-call/result turn"`
Expected: FAIL — current `assemblePrompt` flattens the assistant turn to a string (`content` is a string, no `tool` message). (`await` on the still-sync function is harmless.)

- [ ] **Step 3: Implement the converter + make `assemblePrompt` async (`prompt.ts`)**

(a) Change the top `ai` import (line 2) to include the value import, and add the logger:

```ts
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import type { Chip, MessageDto, ReadingContext } from "@shared/chat";
import { createLogger } from "@main/logger";

const log = createLogger("ai");
```

(b) Add these helpers just above `assemblePrompt` (after `pdfSystemNote`):

```ts
type AssistantPart = UIMessage["parts"][number];

/**
 * readPage 的 image 模式 tool-result 是整页 PNG 的 base64（tools.ts），逐轮回放成本极高。
 * 历史回放时把它换成短文本占位——模型仍看到「真的调过 readPage」，只是不再重发大图
 * （决策：保留调用、省略图像）。readPage 是唯一产图工具，故只需匹配 output.kind==="image"。
 */
function elideImageToolOutput(part: AssistantPart): AssistantPart {
  const output = (part as { output?: unknown }).output;
  if (output && typeof output === "object" && (output as { kind?: unknown }).kind === "image") {
    const page = (output as { page?: unknown }).page;
    return {
      ...(part as object),
      output: { note: `[page ${page} image omitted from history]` },
    } as AssistantPart;
  }
  return part;
}

/**
 * 把一条历史 assistant 消息回放成原生结构化 ModelMessage：assistant(text + tool-call) + tool(result)
 * （#42——让模型重新看到「真调工具 → 拿结果 → 再答」的范式，而非被抹成纯散文后误学出「假装调用」）。
 * 跨轮 reasoning 砍掉（持久化 reasoning 跨 provider/model 回放有 API 不匹配风险；非 bug 成因）；
 * readPage 图像 tool-result 占位省 token；孤儿/半截 tool-call 经 ignoreIncompleteToolCalls 丢弃。
 * 转换失败 → 优雅降级为纯文本 assistant 消息 + warn（历史回放绝不搞崩发送）。
 */
async function assistantHistoryToModelMessages(h: PromptHistoryMessage): Promise<ModelMessage[]> {
  try {
    const parts = h.parts.filter((p) => p.type !== "reasoning").map(elideImageToolOutput);
    const converted = await convertToModelMessages(
      [{ role: "assistant", parts } as Omit<UIMessage, "id">],
      { ignoreIncompleteToolCalls: true },
    );
    if (converted.length > 0) return converted;
  } catch (err) {
    log.warn("history convert fallback", err);
  }
  const text = textOfParts(h.parts);
  return text ? [{ role: "assistant", content: text }] : [];
}
```

(c) Replace the `assemblePrompt` header + history loop (the rest of the body is unchanged):

```ts
/** 组装分层上下文为 ModelMessage[]（设计文档 §10）。无 Electron/DB 依赖；因 convertToModelMessages 为 async 故本函数 async。 */
export async function assemblePrompt(params: AssemblePromptParams): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];

  const summary = params.priorSummary?.trim() ? params.priorSummary.trim() : null;
  const sysParts: string[] = [];
  if (params.systemPrompt) sysParts.push(params.systemPrompt);
  if (summary) sysParts.push(`## Conversation summary so far\n${summary}`);
  if (sysParts.length > 0) out.push({ role: "system", content: sysParts.join("\n\n") });

  for (const h of params.history) {
    // 历史里的 system 消息丢弃：系统提示词由当前 Assistant 重新注入，避免重复/冲突
    if (h.role === "system") continue;
    if (h.role === "assistant") {
      out.push(...(await assistantHistoryToModelMessages(h)));
      continue;
    }
    out.push({ role: "user", content: renderHistoryMessage(h) });
  }

  // Reading position is intentionally injected only into the live/current user turn (unchanged).
  out.push({
    role: "user",
    content: [
      renderReadingContext(params.current.readingContext),
      renderUserTurn(params.current.chips, params.current.userText),
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n"),
  });

  return out;
}
```

> Keep `textOfParts`, `renderUserTurn`, `renderHistoryMessage`, `renderReadingContext`, `pdfSystemNote` exactly as they are.

- [ ] **Step 4: Make `runSend`/`runResend` async (`send.ts`)**

- `export function runSend(...): SendResult {` → `export async function runSend(...): Promise<SendResult> {`
- `export function runResend(...): SendResult {` → `export async function runResend(...): Promise<SendResult> {`
- Both `assemblePrompt({ ... })` call sites (≈`:93` and `:185`) → prefix `await`:

```ts
  const allMessages: ModelMessage[] = await assemblePrompt({
```

Nothing else in those functions changes (early `return { ok: false, ... }` and the trailing `return streamAssistantReply(...)` are valid in an async function).

- [ ] **Step 5: Make the IPC binds async (`ai-handlers.ts`)**

Change both binds to async handlers and await the runner. For `C.aiSend`:

```ts
  bind(C.aiSend, async (req, event: IpcMainInvokeEvent): Promise<SendAck> => {
    const { streamId, ...input } = req;
    const controller = new AbortController();
    activeStreams.set(streamId, { controller, conversationId: input.conversationId });

    const result = await runSend(makeSendDeps(), input, { abortSignal: controller.signal });
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

Apply the identical change to the `C.aiResend` bind (async handler, `await runResend(...)`). `register()` already does `await fn(...)` and `bind` accepts `O | Promise<NoInfer<O>>`, so no registry change is needed.

- [ ] **Step 6: Update existing tests to await (`prompt.test.ts` + `send.test.ts`)**

`prompt.test.ts`: for **every** `it(...)` whose body calls `assemblePrompt` (the `describe("assemblePrompt", ...)` and `describe("assemblePrompt priorSummary", ...)` blocks), make the callback `async () =>` and `await` the `assemblePrompt(...)` call. Leave `describe("renderHistoryMessage", ...)` and `describe("pdfSystemNote", ...)` unchanged. Then fix the one string-flattening assertion in `"re-expands each historical user turn from its own metadata chips (isomorphic with current turn)"`:

```ts
expect(out[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "earlier answer" }] });
```

`send.test.ts`: every `it(...)` is already `async`; change each `const r = runSend(...)` / `const result = runSend(...)` / inline `runResend(...)` to `await` it, e.g.:

```ts
const r = await runSend(deps, input(book.id, convo.id));
```

```ts
expect(
  (await runResend(deps, { conversationId: convo.id, userMessageId: "nope", userText: "x" })).ok,
).toBe(false);
```

In `"persists an aborted-status assistant message when the signal aborts mid-stream"`, after `const r = await runSend(...)`, the `controller.abort()` still fires before the 50ms-delayed chunks finish; update the stale comment to `// runSend 返回后立即中止，分片仍在 50ms 延迟途中`.

- [ ] **Step 7: Verify green**

Run: `pnpm typecheck && pnpm test src/main/ai/prompt.test.ts src/main/ai/send.test.ts`
Expected: no type errors; both test files PASS (new structured-replay test + all awaited existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/main/ai/prompt.ts src/main/ai/send.ts src/main/ipc/ai-handlers.ts src/main/ai/prompt.test.ts src/main/ai/send.test.ts
git commit -m "feat(ai): replay assistant tool-call/result parts in history (#42)"
```

(If the pre-commit hook reformats files and aborts, `git add` the changed files and re-run the same commit once.)

---

## Task 2: Edge-case unit tests (image elision, reasoning drop, orphan drop, fallback)

**Files:**

- Test: `src/main/ai/prompt.test.ts`

- [ ] **Step 1: Add the edge-case tests**

Append inside `describe("assemblePrompt", ...)`:

```ts
it("elides a readPage image tool-result to a placeholder (no base64 replayed)", async () => {
  const out = await assemblePrompt({
    systemPrompt: null,
    history: [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the page." },
          {
            type: "tool-readPage",
            toolCallId: "img1",
            state: "output-available",
            input: { page: 3, mode: "image" },
            output: { kind: "image", page: 3, data: "BASE64BLOBSHOULDNOTAPPEAR" },
          },
        ] as PromptHistoryMessage["parts"],
        metadata: null,
      },
    ],
    current: { chips: [], userText: "next" },
  });
  const dump = JSON.stringify(out);
  expect(dump).not.toContain("BASE64BLOBSHOULDNOTAPPEAR");
  expect(dump).toContain("[page 3 image omitted from history]");
});

it("drops cross-turn reasoning parts from replayed history", async () => {
  const out = await assemblePrompt({
    systemPrompt: null,
    history: [
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "SECRET_CHAIN_OF_THOUGHT", state: "done" },
          { type: "text", text: "answer" },
        ] as PromptHistoryMessage["parts"],
        metadata: null,
      },
    ],
    current: { chips: [], userText: "next" },
  });
  expect(JSON.stringify(out)).not.toContain("SECRET_CHAIN_OF_THOUGHT");
});

it("drops an orphan tool-call (no result) without throwing", async () => {
  const out = await assemblePrompt({
    systemPrompt: null,
    history: [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "partial" },
          {
            type: "tool-readPage",
            toolCallId: "orphan",
            state: "input-available",
            input: { page: 9, mode: "text" },
          },
        ] as PromptHistoryMessage["parts"],
        metadata: null,
      },
    ],
    current: { chips: [], userText: "next" },
  });
  expect(out.some((m) => m.role === "tool")).toBe(false);
  expect(JSON.stringify(out)).toContain("partial");
});

it("keeps a plain text assistant turn equivalent (regression)", async () => {
  const out = await assemblePrompt({
    systemPrompt: null,
    history: [{ role: "assistant", parts: [{ type: "text", text: "just text" }], metadata: null }],
    current: { chips: [], userText: "next" },
  });
  expect(
    out.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("just text")),
  ).toBe(true);
  expect(out.some((m) => m.role === "tool")).toBe(false);
});
```

- [ ] **Step 2: Run the prompt test file**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: PASS (all four edge tests green against the Task 1 implementation). If the image-elision test fails because a real persisted `readPage` image part stores a different shape than `{kind:"image",...}`, inspect a real persisted part and adjust `elideImageToolOutput`'s match (still elide the base64), then re-run.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/prompt.test.ts
git commit -m "test(ai): cover image elision, reasoning drop, orphan tool-calls (#42)"
```

---

## Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, full test suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. (`pnpm lint` must not flag the new code; `await convertToModelMessages` satisfies any require-await rule on `assemblePrompt`/`assistantHistoryToModelMessages`.)

- [ ] **Step 2: Manual smoke (real app — recommended)**

Per CLAUDE.md, dev runs against the `marginalia-dev` userData. In a conversation that previously used a tool (ask about the current page so the model calls `readChapterText`/`readPage`), send a **follow-up** message and confirm via dev logs (`userData/logs/main-YYYY-MM-DD.log`, domain `send`/`ai`) that the model issues a real `tool_call` rather than narrating a fake one. No `history convert fallback` warns should appear in the happy path.

- [ ] **Step 3: Commit (only if smoke required a fix)**

No commit if nothing changed.

---

## Task 4: Spec amendment + changeset

**Files:**

- Modify: `docs/superpowers/specs/2026-06-09-history-replay-tool-parts-design.md`
- Create: `.changeset/history-replay-tool-parts.md`

- [ ] **Step 1: Record the async amendment in the spec**

Append a new section to the spec:

```markdown
## 10. 实现期修正（2026-06-09）

`convertToModelMessages`（ai@6.0.193）实测为 **async**（`Promise<ModelMessage[]>`），与 §3/§7「`assemblePrompt` 保持同步」的假设冲突。**修正**：仍采用方案 A（SDK 转换——正确处理多步 `step-start` 边界，手工同步映射会重排语义），将 `assemblePrompt`、`runSend`/`runResend` 及两个 `ai:*` IPC bind 一并改为 async（IPC invoke 本就 async、`registry.bind` 已支持 `Promise<O>`）。「纯函数」语义收窄为「无 Electron/DB 依赖、headless 可测」，async 与之正交。无 `tools` 选项即可还原 `tool-${name}` part 为 tool-call/result（实测确认）。
```

- [ ] **Step 2: Write the changeset**

Create `.changeset/history-replay-tool-parts.md`:

```markdown
---
"marginalia": patch
---

Fix the AI assistant pretending to call reading tools in longer conversations. Past assistant turns now replay their real tool calls and results in history (instead of being flattened to text), so the model keeps actually reading the book instead of imitating a tool-free transcript.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-09-history-replay-tool-parts-design.md .changeset/history-replay-tool-parts.md
git commit -m "docs(ai): record async amendment + changeset for history replay (#42)"
```

---

## Done criteria

- [ ] `assemblePrompt` replays assistant tool-call/result turns as structured `assistant` + `tool` ModelMessages.
- [ ] Cross-turn `reasoning` dropped; `readPage` image results elided to a placeholder; orphan tool-calls dropped; conversion failure falls back to text + warn.
- [ ] `runSend`/`runResend` and the `ai:*` binds are async; `resend` covered automatically.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
- [ ] Spec amended; changeset added.
- [ ] (Branch `fix/history-replay-tool-parts`; finish via finishing-a-development-branch when ready to merge.)
