# Conversation Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the prompt length of long AI conversations by keeping a background-maintained rolling summary of older turns plus a verbatim recent-turn window, so the model stays focused instead of drifting once history grows large.

**Architecture:** A conversation gains two persisted fields — `contextSummary` (rolling summary) and `summarizedThroughSeq` (`S`, the highest message `seq` folded into it). On send, the prompt = `system (+ summary)` + verbatim turns with `seq > S` + current turn. After each completed turn, a fire-and-forget background job folds the oldest verbatim turns into the summary when the verbatim tail exceeds a token budget. All assembly stays pure; only the background job calls the model.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), Vercel AI SDK v6 (`generateText`), Zod, vitest (Electron runtime, `:memory:` SQLite).

**Spec:** `docs/superpowers/specs/2026-06-08-conversation-context-management-design.md`

---

## File Structure

- **Modify** `src/main/db/schema.ts` — add `context_summary` + `summarized_through_seq` columns to `conversations`.
- **Create** `src/main/db/migrations/<generated>/` — via `pnpm db:generate` (do not hand-write).
- **Modify** `src/main/chat/messages.ts` — add `listMessagesAfterSeq`.
- **Modify** `src/main/ai/prompt.ts` — export `renderHistoryMessage`, route `assemblePrompt` history through it, add `priorSummary` param.
- **Create** `src/main/ai/context-compaction.ts` — budget/fold pure core + background orchestrator.
- **Modify** `src/main/ai/send.ts` — load summary + `S`, fetch tail-only history, pass `priorSummary`, trigger compaction after a completed turn.
- **Modify** test files alongside each (`*.test.ts`) and **create** `src/main/ai/context-compaction.test.ts`.

Each task is independently committable and leaves the suite green (compaction is a no-op below the 100k budget, so existing `send` tests are unaffected).

---

## Task 1: Schema columns + migration

**Files:**

- Modify: `src/main/db/schema.ts:157-174` (the `conversations` table)
- Create: `src/main/db/migrations/<generated>/` (via `pnpm db:generate`)

- [ ] **Step 1: Add the two columns**

In `src/main/db/schema.ts`, the `conversations` table currently is:

```ts
export const conversations = sqliteTable(
  "conversations",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id")
      .notNull()
      .references(() => assistants.id),
    title: text("title"),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("conversations_book_id_idx").on(t.bookId)],
);
```

Insert the two nullable columns after `title`:

```ts
    title: text("title"),
    // 上下文管理（spec 2026-06-08）：滚动概要 + 已折叠到的消息 seq。
    // null = 尚未折叠（全量逐字，等价旧行为）。
    contextSummary: text("context_summary"),
    summarizedThroughSeq: integer("summarized_through_seq"),
    createdAt: nowMs(),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new directory `src/main/db/migrations/<timestamp>_<name>/` containing `migration.sql` (with `ALTER TABLE conversations ADD ...` for both columns) and `snapshot.json`. Do not hand-edit either file.

- [ ] **Step 3: Verify types compile**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Verify migrations apply on a fresh DB**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS (every test runs `runMigrations` on a fresh `:memory:` DB; this proves the new migration applies cleanly).

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(db): add conversation context summary columns"
```

---

## Task 2: `listMessagesAfterSeq`

**Files:**

- Modify: `src/main/chat/messages.ts` (imports at line 2; add function after `listMessages`, ~line 92)
- Test: `src/main/chat/messages.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `src/main/chat/messages.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage, listMessagesAfterSeq } from "@main/chat/messages";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

async function seedConversation() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const convo = createConversation(db, { bookId: book.id });
  for (let i = 0; i < 4; i++) {
    appendMessage(db, {
      conversationId: convo.id,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `m${i}` }],
    });
  }
  return { db, conversationId: convo.id };
}

describe("listMessagesAfterSeq", () => {
  it("returns all messages when afterSeq is null", async () => {
    const { db, conversationId } = await seedConversation();
    expect(listMessagesAfterSeq(db, conversationId, null).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns only the tail with seq > afterSeq", async () => {
    const { db, conversationId } = await seedConversation();
    expect(listMessagesAfterSeq(db, conversationId, 1).map((m) => m.seq)).toEqual([2, 3]);
  });

  it("returns an empty array when afterSeq is at or past the last seq", async () => {
    const { db, conversationId } = await seedConversation();
    expect(listMessagesAfterSeq(db, conversationId, 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/chat/messages.test.ts`
Expected: FAIL — `listMessagesAfterSeq` is not exported.

- [ ] **Step 3: Implement `listMessagesAfterSeq`**

In `src/main/chat/messages.ts`, extend the drizzle import on line 2 to include `and` and `gt`:

```ts
import { and, asc, desc, eq, gt, max } from "drizzle-orm";
```

Add this function immediately after `listMessages` (after line 92):

```ts
/** 列出 seq > afterSeq 的尾轮（升序）；afterSeq 为 null 取全量（等价 listMessages）。 */
export function listMessagesAfterSeq(
  db: DB,
  conversationId: string,
  afterSeq: number | null,
): MessageDto[] {
  const where =
    afterSeq == null
      ? eq(messages.conversationId, conversationId)
      : and(eq(messages.conversationId, conversationId), gt(messages.seq, afterSeq));
  return db.select().from(messages).where(where).orderBy(asc(messages.seq)).all().map(toDto);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/chat/messages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/messages.ts src/main/chat/messages.test.ts
git commit -m "feat(chat): add listMessagesAfterSeq for tail-only history"
```

---

## Task 3: `renderHistoryMessage` + `assemblePrompt` summary injection

**Files:**

- Modify: `src/main/ai/prompt.ts` (add `renderHistoryMessage`; refactor `assemblePrompt` lines 92-124)
- Test: `src/main/ai/prompt.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

Append to `src/main/ai/prompt.test.ts` (create with this import block if the file does not exist):

```ts
import { describe, expect, it } from "vitest";
import { assemblePrompt, renderHistoryMessage } from "@main/ai/prompt";
import type { Chip } from "@shared/chat";

const chip = (id: Chip["id"], content: string): Chip => ({
  id,
  labelKey: "x",
  content,
  tokenCount: 1,
  state: "required",
});

describe("renderHistoryMessage", () => {
  it("renders an assistant turn as its text parts only", () => {
    expect(
      renderHistoryMessage({
        role: "assistant",
        parts: [
          { type: "reasoning", text: "ignored", state: "done" },
          { type: "text", text: "hello" },
        ],
        metadata: null,
      }),
    ).toBe("hello");
  });

  it("renders a user turn with its chip sections then the text", () => {
    const out = renderHistoryMessage({
      role: "user",
      parts: [{ type: "text", text: "why?" }],
      metadata: { contextChips: [{ id: "selection", content: "the cat", tokenCount: 1 }] },
    });
    expect(out).toContain("## 选中文本\nthe cat");
    expect(out).toContain("why?");
  });
});

describe("assemblePrompt priorSummary", () => {
  it("appends the summary to the system message when present", () => {
    const msgs = assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: "earlier we discussed X",
      history: [],
      current: { chips: [], userText: "hi" },
    });
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toContain("BASE");
    expect(msgs[0]?.content).toContain("## Conversation summary so far\nearlier we discussed X");
  });

  it("leaves the system message unchanged when priorSummary is null", () => {
    const msgs = assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: null,
      history: [],
      current: { chips: [], userText: "hi" },
    });
    expect(msgs[0]?.content).toBe("BASE");
  });

  it("only renders the tail history it is given", () => {
    const msgs = assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: "S",
      history: [{ role: "assistant", parts: [{ type: "text", text: "kept" }], metadata: null }],
      current: { chips: [], userText: "now" },
    });
    const joined = JSON.stringify(msgs);
    expect(joined).toContain("kept");
    expect(joined).toContain("now");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: FAIL — `renderHistoryMessage` not exported and `priorSummary` not in params.

- [ ] **Step 3: Add `priorSummary` to params and `renderHistoryMessage`, refactor `assemblePrompt`**

In `src/main/ai/prompt.ts`, add `priorSummary` to the params interface (after `history`):

```ts
export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  /** 滚动概要（已折叠的早期轮）；非空时拼入 system。null = 无概要。 */
  priorSummary?: string | null;
  current: { chips: Chip[]; userText: string; readingContext?: ReadingContext | null };
}
```

Add `renderHistoryMessage` immediately after `renderUserTurn` (after line 44):

```ts
/**
 * 把单条历史消息渲染成喂模型的纯文本：assistant 取 text part（reasoning/tool part 不回放），
 * user 轮带其 chips。assemblePrompt 与上下文压缩共用此单一渲染口径。
 */
export function renderHistoryMessage(h: PromptHistoryMessage): string {
  return h.role === "assistant"
    ? textOfParts(h.parts)
    : renderUserTurn(h.metadata?.contextChips ?? [], textOfParts(h.parts));
}
```

Replace the body of `assemblePrompt` (lines 92-124) with:

```ts
export function assemblePrompt(params: AssemblePromptParams): ModelMessage[] {
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
      out.push({ role: "assistant", content: renderHistoryMessage(h) });
      continue;
    }
    out.push({ role: "user", content: renderHistoryMessage(h) });
  }

  // Reading position is intentionally injected only into the live/current user turn:
  // it changes on scroll, so putting it in system/history would churn prompt-cache prefixes.
  // It is also not persisted in message metadata; future turns get their own fresh position.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/prompt.ts src/main/ai/prompt.test.ts
git commit -m "feat(ai): render history via a shared helper; inject rolling summary into system"
```

---

## Task 4: Compaction pure core (`planFold`, `renderFoldedTranscript`, constants)

**Files:**

- Create: `src/main/ai/context-compaction.ts`
- Test: `src/main/ai/context-compaction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/context-compaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MessageDto } from "@shared/chat";
import { planFold } from "@main/ai/context-compaction";

/** 构造最小 MessageDto（planFold 只用 seq/role；其余补齐以满足类型）。 */
function msg(seq: number, role: "user" | "assistant"): MessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c",
    role,
    parts: [{ type: "text", text: `t${seq}` }],
    metadata: null,
    status: "complete",
    seq,
    createdAt: 0,
  };
}

/** seq 0,1,2,... 交替 user/assistant，共 n 条。 */
function tail(n: number, startSeq = 0): MessageDto[] {
  return Array.from({ length: n }, (_, i) =>
    msg(startSeq + i, (startSeq + i) % 2 === 0 ? "user" : "assistant"),
  );
}

const each10 = () => 10; // 每条 10 token

describe("planFold", () => {
  it("returns null when the tail estimate is at or below the high-water", () => {
    expect(planFold(tail(4), each10, { high: 100, low: 20, minRecent: 2 })).toBeNull();
  });

  it("folds the oldest exchanges down toward the low-water, on an assistant boundary", () => {
    // 8 条 ×10 = 80 > high 1；low 25 → keep 2 条（seq 6,7），fold seq 0..5
    const plan = planFold(tail(8), each10, { high: 1, low: 25, minRecent: 2 });
    expect(plan).not.toBeNull();
    expect(plan!.foldThroughSeq).toBe(5);
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never folds below the minRecent floor even if the low-water wants more", () => {
    // low 5 想只留 1 条，但 minRecent 4 → 至少留 4 条（seq 4,5,6,7）
    const plan = planFold(tail(8), each10, { high: 1, low: 5, minRecent: 4 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(plan!.foldThroughSeq).toBe(3);
  });

  it("aligns the kept region to a user boundary (keeps one more rather than splitting a pair)", () => {
    // 6 条；minRecent 3 落在 assistant 上 → 多保留前面的 user，实际留 4 条（seq 2..5）
    const plan = planFold(tail(6), each10, { high: 1, low: 5, minRecent: 3 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1]);
    expect(plan!.foldThroughSeq).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/context-compaction.test.ts`
Expected: FAIL — module/`planFold` does not exist.

- [ ] **Step 3: Implement the pure core**

Create `src/main/ai/context-compaction.ts` with the constants, `planFold`, and `renderFoldedTranscript` (orchestrator added in Task 5):

```ts
// src/main/ai/context-compaction.ts
import type { MessageDto } from "@shared/chat";
import { renderHistoryMessage } from "@main/ai/prompt";

/** 尾轮估算超此值（token）才触发压缩。 */
export const TAIL_TOKENS_HIGH = 100_000;
/** 压缩目标：折叠到尾轮估算 ≤ 此值。 */
export const TAIL_TOKENS_LOW = 10_000;
/** 最少逐字保留的消息条数（地板，优先于低水位）。 */
export const MIN_RECENT_TURNS = 20;
/** 滚动概要单次再摘要的输出上限（token）。 */
export const SUMMARY_MAX_TOKENS = 4096;
/** 折叠转写喂模型的字符上限；超出前载截断（保留较新的折叠内容）。 */
export const COMPACTION_INPUT_MAX_CHARS = 180_000;

export interface FoldPlan {
  /** S 推进到的消息 seq（最后一条被折叠的 assistant 消息）。 */
  foldThroughSeq: number;
  /** 被折叠进概要的轮（升序）。 */
  foldedTurns: MessageDto[];
}

export interface FoldBudget {
  high: number;
  low: number;
  minRecent: number;
}

/**
 * 纯函数：给定尾轮（seq 升序、user/assistant 交替起于 user）与每条估算 token 的函数，
 * 决定折叠哪个前缀。仅当尾轮估算 > high 才折；尽量多保留近期轮（折到 ≤ low），但至少
 * 保留 minRecent 条，且折叠边界落在 assistant 上（折完整对话对）。无可折返回 null。
 */
export function planFold(
  tail: MessageDto[],
  tokensOf: (m: MessageDto) => number,
  budget: FoldBudget,
): FoldPlan | null {
  const total = tail.reduce((s, m) => s + tokensOf(m), 0);
  if (total <= budget.high) return null;

  // 从最新往旧累积保留：keep 至少 minRecent 条；超过后，一旦再加更老一条会越过 low 就停。
  let keep = 0;
  let acc = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tokensOf(tail[i]!);
    if (keep >= budget.minRecent && acc + t > budget.low) break;
    acc += t;
    keep++;
  }

  // 对齐：保留区须以 user 起（折叠区以 assistant 收）；若首条是 assistant，多保留它前面的 user。
  let keepStart = tail.length - keep;
  if (keepStart > 0 && tail[keepStart]!.role === "assistant") keepStart--;

  const foldCount = keepStart;
  if (foldCount <= 0) return null;
  return { foldThroughSeq: tail[foldCount - 1]!.seq, foldedTurns: tail.slice(0, foldCount) };
}

/** 把折叠轮转写成「User: …\nAssistant: …」串；超长前载截断保留较新内容。 */
export function renderFoldedTranscript(
  folded: MessageDto[],
  maxChars = COMPACTION_INPUT_MAX_CHARS,
): string {
  const transcript = folded
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${renderHistoryMessage(m)}`)
    .join("\n\n");
  return transcript.length > maxChars ? transcript.slice(transcript.length - maxChars) : transcript;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/context-compaction.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/context-compaction.ts src/main/ai/context-compaction.test.ts
git commit -m "feat(ai): add context-compaction fold-budget pure core"
```

---

## Task 5: Compaction orchestrator (`maybeCompactConversation`)

**Files:**

- Modify: `src/main/ai/context-compaction.ts` (add imports, orchestrator, runtime reset)
- Test: `src/main/ai/context-compaction.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/main/ai/context-compaction.test.ts`:

```ts
import path from "node:path";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { conversations } from "@main/db/schema";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { __resetCompactionRuntime, maybeCompactConversation } from "@main/ai/context-compaction";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function summaryModel(text: string): ResolvedModel {
  return {
    ok: true,
    modelId: "sum",
    model: new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        content: [{ type: "text" as const, text }],
        warnings: [],
      }),
    }),
  };
}

async function seedSixTurns() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const convo = createConversation(db, { bookId: book.id });
  for (let i = 0; i < 6; i++) {
    appendMessage(db, {
      conversationId: convo.id,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${i}` }],
    });
  }
  return { db, conversationId: convo.id };
}

function readConvo(db: ReturnType<typeof createDb>, id: string) {
  return db
    .select({
      summary: conversations.contextSummary,
      through: conversations.summarizedThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
}

// 小阈值强制触发（无需真造 100k token）；minRecent 2 → 6 条折到留 2。
const FORCE = { high: 1, low: 1, minRecent: 2 };

describe("maybeCompactConversation", () => {
  afterEach(() => __resetCompactionRuntime());

  it("folds old turns into the summary and advances summarizedThroughSeq", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation(
      { db, resolveModel: () => summaryModel("ROLLED UP") },
      conversationId,
      FORCE,
    );
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBe("ROLLED UP");
    expect(row?.through).toBe(3); // 折 seq 0..3，留 seq 4,5
  });

  it("leaves summary and seq untouched when the model is unconfigured", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation(
      { db, resolveModel: () => ({ ok: false, reason: "unset" }) },
      conversationId,
      FORCE,
    );
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });

  it("leaves summary and seq untouched when summarization throws", async () => {
    const { db, conversationId } = await seedSixTurns();
    const throwing: ResolvedModel = {
      ok: true,
      modelId: "sum",
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("summarizer boom");
        },
      }),
    };
    await maybeCompactConversation({ db, resolveModel: () => throwing }, conversationId, FORCE);
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });

  it("is a no-op below the high-water budget", async () => {
    const { db, conversationId } = await seedSixTurns();
    await maybeCompactConversation({ db, resolveModel: () => summaryModel("X") }, conversationId, {
      high: 1_000_000,
      low: 10,
      minRecent: 2,
    });
    const row = readConvo(db, conversationId);
    expect(row?.summary).toBeNull();
    expect(row?.through).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/context-compaction.test.ts`
Expected: FAIL — `maybeCompactConversation` / `__resetCompactionRuntime` not exported.

- [ ] **Step 3: Implement the orchestrator**

In `src/main/ai/context-compaction.ts`, add these imports at the top (below the existing ones):

```ts
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { listMessagesAfterSeq } from "@main/chat/messages";
import { estimateTokens } from "@shared/tokens";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { createLogger } from "@main/logger";

const log = createLogger("summary");
```

Append the orchestrator at the bottom of the file:

```ts
export interface CompactionDeps {
  db: DB;
  /** 摘要模型解析器（与章节/全书摘要、自动命名同源 resolveSummaryModel）。 */
  resolveModel: () => ResolvedModel;
}

const COMPACTION_SYSTEM =
  "You maintain a running summary of an ongoing conversation between a user and a reading " +
  "assistant about a book. Given the previous summary and new exchanges, produce an updated, " +
  "concise summary that preserves: what the user is reading, the user's stated opinions, " +
  "preferences and decisions, and any facts the assistant should remember. Drop pleasantries " +
  "and redundancy. Output only the summary, no preamble.";

// 压缩中状态：进程内瞬态去重（镜像 summary.ts 的 inFlight*），重启自然归零。
const compactingConversations = new Set<string>();

/** 仅供测试：清空压缩运行时态。 */
export function __resetCompactionRuntime(): void {
  compactingConversations.clear();
}

/**
 * 轮后 fire-and-forget：尾轮（seq > S）超预算时，把最老的若干完整对话对折叠进滚动概要，
 * 推进 summarizedThroughSeq。失败/未配置模型/会话被删一律 warn 并保持原状（下轮再试），
 * 绝不阻塞发送。budget 默认用模块常量，测试可注入小阈值强制触发。
 */
export async function maybeCompactConversation(
  deps: CompactionDeps,
  conversationId: string,
  budget: FoldBudget = {
    high: TAIL_TOKENS_HIGH,
    low: TAIL_TOKENS_LOW,
    minRecent: MIN_RECENT_TURNS,
  },
): Promise<void> {
  const { db, resolveModel } = deps;
  if (compactingConversations.has(conversationId)) return; // 并发去重
  const resolved = resolveModel();
  if (!resolved.ok) {
    log.warn("summary model not configured; skip compaction", resolved.reason);
    return;
  }
  compactingConversations.add(conversationId);
  try {
    const convo = db
      .select({
        summary: conversations.contextSummary,
        through: conversations.summarizedThroughSeq,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!convo) return; // 会话已删

    const tail = listMessagesAfterSeq(db, conversationId, convo.through);
    const plan = planFold(tail, (m) => estimateTokens(renderHistoryMessage(m)), budget);
    if (!plan) return; // 未超高水位 / 无可折

    const prior = convo.summary?.trim() ? `Previous summary:\n${convo.summary.trim()}\n\n` : "";
    const transcript = renderFoldedTranscript(plan.foldedTurns);
    const { text } = await generateText({
      model: resolved.model,
      system: COMPACTION_SYSTEM,
      prompt: `${prior}New exchanges:\n${transcript}`,
      maxOutputTokens: SUMMARY_MAX_TOKENS,
      maxRetries: 1,
    });
    if (!text.trim()) {
      // provider 不抛错但产出空文本 → 不推进（否则丢失这些轮且永不重摘）
      log.warn(`conversation ${conversationId} compaction produced empty summary; skip`);
      return;
    }

    // 写回前复查会话仍在（压缩中途被删 → 丢弃；better-sqlite3 同步驱动，check-then-act 安全）
    const still = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!still) {
      log.debug("conversation deleted mid-compaction; drop", conversationId);
      return;
    }
    db.update(conversations)
      .set({ contextSummary: text.trim(), summarizedThroughSeq: plan.foldThroughSeq })
      .where(eq(conversations.id, conversationId))
      .run();
  } catch (err) {
    log.warn(`conversation ${conversationId} compaction failed`, err);
  } finally {
    compactingConversations.delete(conversationId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/context-compaction.test.ts`
Expected: PASS (8 tests total: 4 from Task 4 + 4 here).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/context-compaction.ts src/main/ai/context-compaction.test.ts
git commit -m "feat(ai): add background conversation compaction orchestrator"
```

---

## Task 6: Wire compaction into `runSend`

**Files:**

- Modify: `src/main/ai/send.ts` (imports; step 1b select lines 62-66; step 3 line 77; assemblePrompt call lines 101-105; onFinish `complete` block lines 189-204)
- Test: `src/main/ai/send.test.ts` (append a summary-injection test)

- [ ] **Step 1: Write the failing test**

Append to `src/main/ai/send.test.ts`. The file already defines `setup`, `input`, `finishChunk`, `simulateReadableStream`, `MockLanguageModelV3`. Add a capturing model that records the full prompt, and a test:

```ts
function promptCapturingModel(captured: { system?: string; texts: string[] }) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      captured.system = sys && typeof sys.content === "string" ? sys.content : undefined;
      captured.texts = prompt
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("runSend context summary injection", () => {
  it("injects the stored summary into system and sends only the tail history", async () => {
    const captured: { system?: string; texts: string[] } = { texts: [] };
    const { db, book, deps } = await setup({
      ok: true,
      model: promptCapturingModel(captured),
      modelId: "mock",
    });
    const { createConversation } = await import("@main/chat/conversations");
    const { appendMessage } = await import("@main/chat/messages");
    const { conversations } = await import("@main/db/schema");
    const { eq } = await import("drizzle-orm");

    const convo = createConversation(db, { bookId: book.id });
    // 历史：seq 0(user)/1(assistant)，标记已折叠到 seq 0 + 一段概要
    appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "FOLDED_USER" }],
    });
    appendMessage(db, {
      conversationId: convo.id,
      role: "assistant",
      parts: [{ type: "text", text: "KEPT_ASSISTANT" }],
    });
    db.update(conversations)
      .set({ contextSummary: "EARLIER_SUMMARY", summarizedThroughSeq: 0 })
      .where(eq(conversations.id, convo.id))
      .run();

    const r = runSend(deps, input(book.id, convo.id, { chips: [], userText: "now" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    expect(captured.system).toContain("## Conversation summary so far\nEARLIER_SUMMARY");
    const joined = captured.texts.join("\n");
    expect(joined).toContain("KEPT_ASSISTANT"); // seq 1 > S(0) kept verbatim
    expect(joined).not.toContain("FOLDED_USER"); // seq 0 <= S folded out
    expect(joined).toContain("now"); // current turn
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/send.test.ts -t "context summary injection"`
Expected: FAIL — `runSend` still loads full history and ignores the summary, so `FOLDED_USER` is present / summary marker absent.

- [ ] **Step 3: Wire `runSend`**

In `src/main/ai/send.ts`:

(a) Update the imports — replace the `listMessages` import usage. Line 19 currently:

```ts
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";
```

Change to:

```ts
import { appendMessage, getLastParagraphContent, listMessagesAfterSeq } from "@main/chat/messages";
```

Add the compaction import (after the chips import, line 14 area):

```ts
import { maybeCompactConversation } from "@main/ai/context-compaction";
```

(b) Extend the step-1b select (lines 62-66) to fetch the new fields:

```ts
const convo = db
  .select({
    bookId: conversations.bookId,
    contextSummary: conversations.contextSummary,
    summarizedThroughSeq: conversations.summarizedThroughSeq,
  })
  .from(conversations)
  .where(eq(conversations.id, input.conversationId))
  .get();
```

(c) Replace step 3 (line 77) with the tail-only fetch:

```ts
// 3. 取尾轮历史（seq > S；S=null 取全量。在落入本轮 user 消息之前）
const history = listMessagesAfterSeq(db, conversationId, convo.summarizedThroughSeq);
```

(d) Pass `priorSummary` into the `assemblePrompt` call (lines 101-105):

```ts
const allMessages: ModelMessage[] = assemblePrompt({
  systemPrompt: systemPromptText,
  priorSummary: convo.contextSummary,
  history,
  current: { chips: deduped, userText: input.userText, readingContext: input.readingContext },
});
```

(e) Trigger compaction in the `onFinish` completed-turn block. At the end of the existing `if (status === "complete") { … }` block (after the naming logic, before the block's closing brace, ~line 204), add:

```ts
// 轮后后台压缩（fire-and-forget）：尾轮超预算时折叠旧轮进滚动概要。复用摘要模型。
void maybeCompactConversation({ db, resolveModel: resolveSummaryModel }, conversationId);
```

(`db` and `resolveSummaryModel` are already destructured from `deps` at the top of `runSend`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/ai/send.test.ts`
Expected: PASS — the new injection test passes, and all existing `send` tests still pass (compaction defaults to the 100k budget, a no-op in these fixtures).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/send.ts src/main/ai/send.test.ts
git commit -m "feat(ai): assemble prompt from rolling summary + tail; compact after each turn"
```

---

## Task 7: Full verification + changeset

**Files:**

- Create: `.changeset/<name>.md`

- [ ] **Step 1: Typecheck, lint, format, full test suite**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green. If `format:check` flags files, run `pnpm format` and re-stage.

- [ ] **Step 2: Write the changeset**

Create `.changeset/conversation-context-management.md`:

```markdown
---
"marginalia": minor
---

Keep long AI conversations focused. Once a conversation's recent history grows past a large budget, older turns are folded in the background into a rolling summary while recent turns stay verbatim, so the prompt sent to the model stays bounded instead of growing without limit. This curbs the cost, latency, and quality drift (the assistant losing focus or skipping tool calls) that long reading sessions used to cause. Existing conversations are unaffected until they cross the threshold, and the summary is derived state only — your message history is never altered.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/conversation-context-management.md
git commit -m "docs: changeset for conversation context management"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** §2 prompt shape → Task 3; §3 schema/`assemblePrompt`/`listMessagesAfterSeq`/`runSend` → Tasks 1,2,3,6; §4 trigger/budget/incremental summary → Tasks 4,5,6; §5 error handling → Task 5 tests (unconfigured/throws/deleted); §7 testing → Tasks 2–6; §8 constants → Task 4.
- **Naming consistency:** `renderHistoryMessage`, `listMessagesAfterSeq`, `planFold`, `renderFoldedTranscript`, `maybeCompactConversation`, `CompactionDeps`, `FoldPlan`, `FoldBudget`, `__resetCompactionRuntime`, `contextSummary`/`summarizedThroughSeq` are used identically across tasks.
- **No persistence of summary into `messages`** — it lives only on `conversations` (Task 1).
- **`textOfParts` tool-part behavior unchanged** — `renderHistoryMessage` reuses it as-is.
