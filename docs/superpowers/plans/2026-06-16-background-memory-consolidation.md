# Background Memory Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in background pass that, every N conversation turns, extracts durable facts the inline tools missed and consolidates existing memories via a structured single-shot LLM call + deterministic apply, then surfaces a localized summary toast through a new main→renderer notification channel.

**Architecture:** A new business module `memory-consolidation.ts` mirrors `context-compaction.ts`: pure functions (`applyMemoryOps`, `renderMemoryPassInput`) + a fire-and-forget orchestrator (`maybeConsolidateMemory`) hung on `streamAssistantReply.onFinish`. Writes go through the existing memory repository (link sync for free). A new `app:notify` event channel + `src/main/notify.ts` glue lets main broadcast structured counts; the renderer localizes them to a sonner toast. Gated by a default-off `memoryAutoConsolidate` preference under the `memoryEnabled` master switch.

**Tech Stack:** Electron 41 main process, Drizzle ORM + better-sqlite3, Vercel AI SDK v6 (`generateObject`), Zod 4, React 19 + zustand + react-i18next + sonner, vitest 4 (headless, `:memory:` DB), oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-06-16-background-memory-consolidation-design.md`

---

## File Structure

**New files:**

- `src/main/ai/memory-consolidation.ts` — constants, op schema, `applyMemoryOps` (pure), `renderMemoryPassInput` (pure), `maybeConsolidateMemory` (orchestrator), `__resetConsolidationRuntime`.
- `src/main/ai/memory-consolidation.test.ts` — all unit tests for the module.
- `src/main/notify.ts` — `notifyRenderer` (the only Electron touch on the notify path).
- `src/main/db/conversations-memory-through-seq.test.ts` — migration/column round-trip test.
- `src/renderer/notifications/app-notifications.ts` — `notificationMessage` (pure) + `useAppNotifications` (hook).
- `src/renderer/notifications/app-notifications.test.ts` — `notificationMessage` test.

**Modified files:**

- `src/main/db/schema.ts` — add `conversations.memoryThroughSeq` column.
- `src/shared/chat.ts` — add `AppNotification` type.
- `src/shared/ipc.ts` — add `appNotify` event channel.
- `src/shared/preferences.ts` — register `memoryAutoConsolidate` (schema + `setPreferenceInput` arm).
- `src/main/ipc/preferences-handlers.ts` — add `memoryAutoConsolidate` switch case.
- `src/main/ai/send.ts` — `SendDeps` += `notify`.
- `src/main/ai/send-deps.ts` — `makeSendDeps()` injects `notifyRenderer`.
- `src/main/ai/stream-assistant.ts` — `onFinish` calls `maybeConsolidateMemory`.
- `src/preload-api.ts` — `app.onNotify` subscriber.
- `src/renderer/App.tsx` — mount `useAppNotifications()`.
- `src/renderer/store/prefs-store.ts` — `memoryAutoConsolidate` state + action.
- `src/renderer/store/hydrate-preferences.ts` — hydrate `memoryAutoConsolidate`.
- `src/renderer/settings/MemorySettings.tsx` — auto-consolidate toggle.
- `src/shared/i18n/locales/*` — toast + toggle copy (via `pnpm i18n:extract`).

---

## Task 1: DB column `conversations.memoryThroughSeq`

**Files:**

- Modify: `src/main/db/schema.ts` (conversations table, after `summarizedThroughSeq`)
- Test: `src/main/db/conversations-memory-through-seq.test.ts`
- Generated: `src/main/db/migrations/<timestamp>_<name>/`

- [ ] **Step 1: Write the failing test**

Create `src/main/db/conversations-memory-through-seq.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { conversations } from "@main/db/schema";

const MIGRATIONS = path.resolve(__dirname, "migrations");

describe("conversations.memoryThroughSeq", () => {
  it("defaults to null and round-trips an update", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const convo = createConversation(db, { bookId: book.id });

    const before = db
      .select({ s: conversations.memoryThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, convo.id))
      .get();
    expect(before?.s ?? null).toBeNull();

    db.update(conversations)
      .set({ memoryThroughSeq: 7 })
      .where(eq(conversations.id, convo.id))
      .run();

    const after = db
      .select({ s: conversations.memoryThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, convo.id))
      .get();
    expect(after?.s).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/db/conversations-memory-through-seq.test.ts`
Expected: FAIL — TypeScript error `Property 'memoryThroughSeq' does not exist` (column not yet defined).

- [ ] **Step 3: Add the column to the schema**

In `src/main/db/schema.ts`, inside the `conversations` table, add the line immediately after `summarizedThroughSeq: integer("summarized_through_seq"),`:

```ts
    summarizedThroughSeq: integer("summarized_through_seq"),
    memoryThroughSeq: integer("memory_through_seq"),
```

(`integer` is already imported — it is used by `summarizedThroughSeq`.)

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new directory `src/main/db/migrations/<timestamp>_<name>/` containing `migration.sql` (an `ALTER TABLE conversations ADD ...` for `memory_through_seq`) and `snapshot.json`. Do not hand-edit them.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/main/db/conversations-memory-through-seq.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations src/main/db/conversations-memory-through-seq.test.ts
git commit -m "feat(db): add conversations.memoryThroughSeq watermark column"
```

---

## Task 2: `AppNotification` type + `app:notify` event channel

**Files:**

- Modify: `src/shared/chat.ts` (add type near `AiStreamEvent`)
- Modify: `src/shared/ipc.ts` (import + channel def)
- Test: `src/shared/ipc.test.ts` (create if absent, else append)

- [ ] **Step 1: Write the failing test**

Create `src/shared/ipc.test.ts` (if it already exists, append the `describe` block):

```ts
import { describe, expect, it } from "vitest";
import { C } from "@shared/ipc";

describe("app:notify channel", () => {
  it("is declared as an event channel", () => {
    expect(C.appNotify.channel).toBe("app:notify");
    expect(C.appNotify.kind).toBe("event");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/ipc.test.ts`
Expected: FAIL — `Property 'appNotify' does not exist on type` / `C.appNotify` is undefined.

- [ ] **Step 3: Add the `AppNotification` type**

In `src/shared/chat.ts`, immediately after the `AiStreamEvent` type declaration, add:

```ts
/** main→renderer 通知载荷（判别联合，按 kind 扩展）。renderer 据此本地化成 toast。 */
export type AppNotification = {
  kind: "memoryConsolidated";
  saved: number;
  updated: number;
  deleted: number;
};
```

- [ ] **Step 4: Add the channel to the contract map**

In `src/shared/ipc.ts`, add `AppNotification` to the existing `@shared/chat` type import:

```ts
import type {
  AiStreamEvent,
  AppNotification,
  Chip,
  ConversationDto,
  MessageDto,
  SendAck,
} from "@shared/chat";
```

Then add this entry next to the existing `aiChunk` definition in the `C` map:

```ts
  aiChunk: def("ai:chunk", "event", z.void(), out<AiStreamEvent>()),
  appNotify: def("app:notify", "event", z.void(), out<AppNotification>()),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/shared/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/chat.ts src/shared/ipc.ts src/shared/ipc.test.ts
git commit -m "feat(ipc): add app:notify event channel and AppNotification type"
```

---

## Task 3: Backend preference `memoryAutoConsolidate`

**Files:**

- Modify: `src/shared/preferences.ts` (`PREFERENCE_SCHEMAS` + `setPreferenceInput`)
- Modify: `src/main/ipc/preferences-handlers.ts` (switch case)
- Test: `src/main/preferences/repository.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/main/preferences/repository.test.ts` (inside the top-level `describe`, or add a new one):

```ts
describe("memoryAutoConsolidate preference", () => {
  it("round-trips a boolean and defaults to null when unset", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(getPreference(db, "memoryAutoConsolidate")).toBeNull();
    setPreference(db, "memoryAutoConsolidate", true);
    expect(getPreference(db, "memoryAutoConsolidate")).toBe(true);
  });
});
```

> If `createDb`/`runMigrations`/`getPreference`/`setPreference`/`MIGRATIONS` are not already imported at the top of that test file, mirror the imports used by its existing tests (it already tests this repository).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/preferences/repository.test.ts`
Expected: FAIL — TS error: `"memoryAutoConsolidate"` is not assignable to `PreferenceKey`.

- [ ] **Step 3: Register the preference schema**

In `src/shared/preferences.ts`, add to `PREFERENCE_SCHEMAS` immediately after the `memoryEnabled` line:

```ts
  memoryEnabled: z.boolean(),
  memoryAutoConsolidate: z.boolean(),
```

And add the matching arm to `setPreferenceInput` immediately after the `memoryEnabled` arm:

```ts
  z.object({ key: z.literal("memoryEnabled"), value: z.boolean() }),
  z.object({ key: z.literal("memoryAutoConsolidate"), value: z.boolean() }),
```

- [ ] **Step 4: Add the IPC handler switch case**

In `src/main/ipc/preferences-handlers.ts`, add a case immediately after the `memoryEnabled` case (it does NOT need `invalidateAllAgentContexts` — the consolidation toggle does not affect the frozen agent-context snapshot):

```ts
      case "memoryAutoConsolidate":
        return setPreference(getDb(), input.key, input.value);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/main/preferences/repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the preferences exhaustiveness test + typecheck**

Run: `pnpm test src/shared/preferences.test.ts && pnpm typecheck`
Expected: PASS — the `never` guard in `preferences-handlers.ts` compiles (proves the switch is exhaustive).

- [ ] **Step 7: Commit**

```bash
git add src/shared/preferences.ts src/main/ipc/preferences-handlers.ts src/main/preferences/repository.test.ts
git commit -m "feat(preferences): register memoryAutoConsolidate (default off)"
```

---

## Task 4: `applyMemoryOps` + op schema (memory-consolidation.ts)

**Files:**

- Create: `src/main/ai/memory-consolidation.ts`
- Test: `src/main/ai/memory-consolidation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/memory-consolidation.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { memoryLinks } from "@main/db/schema";
import { applyMemoryOps } from "@main/ai/memory-consolidation";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("applyMemoryOps", () => {
  it("saves a new memory and fills sourceBookId", () => {
    const db = freshDb();
    const r = applyMemoryOps(
      db,
      [
        {
          op: "save",
          slug: "likes-stoicism",
          title: "T",
          description: "D",
          body: "B",
          reason: "x",
        },
      ],
      { sourceBookId: "book-1" },
    );
    expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
    const m = getMemoryBySlug(db, "likes-stoicism");
    expect(m?.sourceBookId).toBe("book-1");
  });

  it("skips a save whose slug already exists (no overwrite)", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "dup",
      title: "orig",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const r = applyMemoryOps(
      db,
      [{ op: "save", slug: "dup", title: "new", description: "d2", body: "b2", reason: "x" }],
      { sourceBookId: null },
    );
    expect(r.saved).toBe(0);
    expect(getMemoryBySlug(db, "dup")?.title).toBe("orig");
  });

  it("updates an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "old", description: "d", body: "b", sourceBookId: null });
    const r = applyMemoryOps(db, [{ op: "update", slug: "m", title: "fresh", reason: "x" }], {
      sourceBookId: null,
    });
    expect(r.updated).toBe(1);
    expect(getMemoryBySlug(db, "m")?.title).toBe("fresh");
  });

  it("deletes an existing memory by slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "gone", title: "t", description: "d", body: "b", sourceBookId: null });
    const r = applyMemoryOps(db, [{ op: "delete", slug: "gone", reason: "merged" }], {
      sourceBookId: null,
    });
    expect(r.deleted).toBe(1);
    expect(getMemoryBySlug(db, "gone")).toBeNull();
  });

  it("skips update/delete on a missing slug without aborting the batch", () => {
    const db = freshDb();
    const r = applyMemoryOps(
      db,
      [
        { op: "update", slug: "ghost", title: "x", reason: "x" },
        { op: "save", slug: "real", title: "t", description: "d", body: "b", reason: "x" },
      ],
      { sourceBookId: null },
    );
    expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
    expect(getMemoryBySlug(db, "real")).not.toBeNull();
  });

  it("syncs [[slug]] links on a saved body", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "target",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    applyMemoryOps(
      db,
      [
        {
          op: "save",
          slug: "source",
          title: "t",
          description: "d",
          body: "see [[target]]",
          reason: "x",
        },
      ],
      { sourceBookId: null },
    );
    const edges = db.select().from(memoryLinks).all();
    expect(edges.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts`
Expected: FAIL — cannot find module `@main/ai/memory-consolidation`.

- [ ] **Step 3: Create the module with the op schema and `applyMemoryOps`**

Create `src/main/ai/memory-consolidation.ts`:

```ts
// src/main/ai/memory-consolidation.ts —— 后台记忆整理 pass（spec 2026-06-16）。
// 结构化单发 + 确定性落库；镜像 context-compaction.ts 的 fire-and-forget 形态。
import { z } from "zod";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  updateMemoryById,
} from "@main/memory/repository";
import { memorySlug } from "@shared/memory";
import type { DB } from "@main/db/client";
import { createLogger } from "@main/logger";

const log = createLogger("memory");

/** 每 N 轮（assistant 轮数）触发一次后台整理。 */
export const MEMORY_PASS_EVERY_N_TURNS = 5;
/** 喂模型的整理输入字符上限（超长前载截断，保留较新内容）。 */
export const MEMORY_PASS_INPUT_MAX_CHARS = 180_000;
/** 单次整理产出的输出 token 上限。 */
export const MEMORY_PASS_MAX_TOKENS = 8192;

/** 整理操作清单（判别联合）：模型只产出它，纯函数确定性 apply。 */
const memoryOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("save"),
    slug: memorySlug,
    title: z.string().min(1),
    description: z.string().min(1),
    body: z.string().min(1),
    reason: z.string(),
  }),
  z.object({
    op: z.literal("update"),
    slug: memorySlug,
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    reason: z.string(),
  }),
  z.object({ op: z.literal("delete"), slug: memorySlug, reason: z.string() }),
]);
export const memoryPassOutput = z.object({ ops: z.array(memoryOp) });
export type MemoryOp = z.infer<typeof memoryOp>;

export interface ApplyResult {
  saved: number;
  updated: number;
  deleted: number;
}

/** 确定性把操作清单落库；复用 repository CRUD（连带 [[slug]] 边表同步）。逐条 try/catch 隔离。 */
export function applyMemoryOps(
  db: DB,
  ops: MemoryOp[],
  opts: { sourceBookId: string | null },
): ApplyResult {
  const result: ApplyResult = { saved: 0, updated: 0, deleted: 0 };
  for (const op of ops) {
    try {
      if (op.op === "save") {
        if (getMemoryBySlug(db, op.slug)) {
          log.warn(`consolidate: save slug exists, skip: ${op.slug}`);
          continue;
        }
        createMemory(db, {
          slug: op.slug,
          title: op.title,
          description: op.description,
          body: op.body,
          sourceBookId: opts.sourceBookId,
        });
        result.saved++;
      } else if (op.op === "update") {
        const existing = getMemoryBySlug(db, op.slug);
        if (!existing) {
          log.warn(`consolidate: update slug missing, skip: ${op.slug}`);
          continue;
        }
        updateMemoryById(db, {
          id: existing.id,
          title: op.title,
          description: op.description,
          body: op.body,
        });
        result.updated++;
      } else {
        const existing = getMemoryBySlug(db, op.slug);
        if (!existing) {
          log.warn(`consolidate: delete slug missing, skip: ${op.slug}`);
          continue;
        }
        deleteMemoryById(db, existing.id);
        result.deleted++;
      }
    } catch (err) {
      log.warn(`consolidate: op failed (${op.op} ${op.slug})`, err);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/memory-consolidation.ts src/main/ai/memory-consolidation.test.ts
git commit -m "feat(ai): add memory op schema and deterministic applyMemoryOps"
```

---

## Task 5: `renderMemoryPassInput` (memory-consolidation.ts)

**Files:**

- Modify: `src/main/ai/memory-consolidation.ts`
- Test: `src/main/ai/memory-consolidation.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/main/ai/memory-consolidation.test.ts`:

```ts
import type { MessageDto } from "@shared/chat";
import type { MemoryDto } from "@shared/memory";
import { renderMemoryPassInput, MEMORY_PASS_INPUT_MAX_CHARS } from "@main/ai/memory-consolidation";

function turn(seq: number, role: "user" | "assistant", text: string): MessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c",
    role,
    parts: [{ type: "text", text }],
    metadata: null,
    status: "complete",
    seq,
    createdAt: 0,
  };
}

function mem(slug: string, body: string): MemoryDto {
  return {
    id: slug,
    slug,
    title: `T-${slug}`,
    description: `D-${slug}`,
    body,
    sourceBookId: null,
    sourceBookTitle: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("renderMemoryPassInput", () => {
  it("includes existing memories and the recent transcript", () => {
    const out = renderMemoryPassInput(
      [turn(1, "user", "hello"), turn(2, "assistant", "hi there")],
      [mem("likes-tea", "drinks tea daily")],
    );
    expect(out).toContain("likes-tea");
    expect(out).toContain("drinks tea daily");
    expect(out).toContain("User: hello");
    expect(out).toContain("Assistant: hi there");
  });

  it("marks an empty memory store", () => {
    const out = renderMemoryPassInput([turn(1, "user", "x")], []);
    expect(out).toContain("(no existing memories)");
  });

  it("truncates to the char cap keeping the newer tail", () => {
    const long = "z".repeat(1000);
    const out = renderMemoryPassInput([turn(1, "user", long)], [], 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("z")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts -t renderMemoryPassInput`
Expected: FAIL — `renderMemoryPassInput` is not exported.

- [ ] **Step 3: Implement `renderMemoryPassInput`**

Add to `src/main/ai/memory-consolidation.ts` — first extend the imports at the top:

```ts
import { renderHistoryMessage } from "@main/ai/prompt";
import type { MessageDto } from "@shared/chat";
import type { MemoryDto } from "@shared/memory";
```

Then append the function:

```ts
/** 渲染整理输入：现有记忆全库（含正文）+ 最近对话转写。超长前载截断保留较新内容。 */
export function renderMemoryPassInput(
  turns: MessageDto[],
  memories: MemoryDto[],
  maxChars = MEMORY_PASS_INPUT_MAX_CHARS,
): string {
  const memoryBlock =
    memories.length === 0
      ? "(no existing memories)"
      : memories
          .map(
            (m) => `- [${m.slug}] ${m.title} — ${m.description}\n  ${m.body.replace(/\n/g, " ")}`,
          )
          .join("\n");
  const transcript = turns
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${renderHistoryMessage(m)}`)
    .join("\n\n");
  const combined = `## Existing memories\n\n${memoryBlock}\n\n## Recent conversation\n\n${transcript}`;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/memory-consolidation.ts src/main/ai/memory-consolidation.test.ts
git commit -m "feat(ai): render memory consolidation pass input"
```

---

## Task 6: `maybeConsolidateMemory` orchestrator

**Files:**

- Modify: `src/main/ai/memory-consolidation.ts`
- Test: `src/main/ai/memory-consolidation.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/main/ai/memory-consolidation.test.ts`:

```ts
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { appendMessage } from "@main/chat/messages";
import { conversations } from "@main/db/schema";
import { setPreference } from "@main/preferences/repository";
import { getMemoryBySlug as getBySlug } from "@main/memory/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import type { AppNotification } from "@shared/chat";
import { maybeConsolidateMemory, __resetConsolidationRuntime } from "@main/ai/memory-consolidation";

const passThrough: RunBackground = (fn) => fn();

/** mock 模型：doGenerate 返回 JSON 文本，generateObject 解析为 { ops }。 */
function opsModel(ops: unknown[]): ResolvedModel {
  return {
    ok: true,
    modelId: "mem",
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
        content: [{ type: "text" as const, text: JSON.stringify({ ops }) }],
        warnings: [],
      }),
    }),
  };
}

async function seedConvo(assistantTurns: number) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const book = await importBook(db, { bytes: makeFixtureEpub() });
  const convo = createConversation(db, { bookId: book.id });
  // 交替 user/assistant，凑够 assistantTurns 条 assistant。
  for (let i = 0; i < assistantTurns * 2; i++) {
    appendMessage(db, {
      conversationId: convo.id,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${i}` }],
    });
  }
  return { db, conversationId: convo.id, bookId: book.id };
}

function readThrough(db: ReturnType<typeof createDb>, id: string) {
  return db
    .select({ s: conversations.memoryThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get()?.s;
}

describe("maybeConsolidateMemory", () => {
  afterEach(() => __resetConsolidationRuntime());

  it("does nothing when memoryAutoConsolidate is off", async () => {
    const { db, conversationId, bookId } = await seedConvo(3);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does nothing below the turn threshold", async () => {
    const { db, conversationId, bookId } = await seedConvo(1);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
  });

  it("applies ops, advances the watermark, and notifies on change", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      {
        db,
        resolveModel: () =>
          opsModel([
            { op: "save", slug: "new-fact", title: "T", description: "D", body: "B", reason: "x" },
          ]),
        runBackground: passThrough,
        notify,
      },
      conversationId,
      bookId,
      2,
    );
    expect(getBySlug(db, "new-fact")?.sourceBookId).toBe(bookId);
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalledWith({
      kind: "memoryConsolidated",
      saved: 1,
      updated: 0,
      deleted: 0,
    });
  });

  it("advances the watermark but does not notify when ops are empty", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId)).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("holds the watermark when the model is unconfigured", async () => {
    const { db, conversationId, bookId } = await seedConvo(2);
    setPreference(db, "memoryAutoConsolidate", true);
    const notify = vi.fn();
    await maybeConsolidateMemory(
      {
        db,
        resolveModel: () => ({ ok: false, reason: "unset" }),
        runBackground: passThrough,
        notify,
      },
      conversationId,
      bookId,
      2,
    );
    expect(readThrough(db, conversationId) ?? null).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
```

> `vi` and `describe`/`it`/`expect` come from vitest; add `vi` to the existing top-of-file `import { ... } from "vitest"` if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts -t maybeConsolidateMemory`
Expected: FAIL — `maybeConsolidateMemory` / `__resetConsolidationRuntime` not exported.

- [ ] **Step 3: Implement the orchestrator**

Add to `src/main/ai/memory-consolidation.ts` — extend the imports:

```ts
import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { conversations } from "@main/db/schema";
import { listMessagesAfterSeq } from "@main/chat/messages";
import { listMemories } from "@main/memory/repository";
import { getPreference } from "@main/preferences/repository";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import type { AppNotification } from "@shared/chat";
```

Then append the system prompt, deps interface, in-flight guard, and the orchestrator:

```ts
const CONSOLIDATION_SYSTEM =
  "You are the memory librarian for a reading assistant named Lia. You are given Lia's existing " +
  "long-term memories about the reader and the most recent exchanges of one conversation. Keep the " +
  "memory store accurate and tidy by emitting a list of operations.\n\n" +
  'Save (op "save") a NEW memory only for durable facts worth remembering across conversations: the ' +
  "reader's lasting preferences, distinctive viewpoints, recurring concepts, thinking frameworks, or " +
  "corrections to Lia's behavior. Do NOT save book content (summaries cover that) or one-off, " +
  'transactional questions. Reuse an existing topic with "update" instead of creating near-duplicates.\n\n' +
  'Update (op "update") to merge near-duplicates into one canonical memory, refine unclear wording, or ' +
  "enrich an existing memory. Body is replaced wholesale when provided.\n\n" +
  'Delete (op "delete") ONLY a redundant duplicate whose content you have merged into another memory in ' +
  "the same batch. NEVER delete a memory just because it looks old or stale — only the reader can judge that.\n\n" +
  "Write memory content in the reader's language; slugs are always English kebab-case. Link related " +
  "memories inside body text with [[slug]]. Be conservative: if nothing is clearly worth changing, return " +
  "an empty ops array. Give a one-sentence reason for each operation.";

export interface ConsolidationDeps {
  db: DB;
  /** 摘要模型解析器（与压缩/命名/摘要同源 resolveSummaryModel）。 */
  resolveModel: () => ResolvedModel;
  /** 后台并发限流端口（与摘要/命名/压缩共用全局上限）。 */
  runBackground: RunBackground;
  /** main→renderer 通知端口（生产=notifyRenderer，测试注入 spy）。 */
  notify: (n: AppNotification) => void;
}

// 整理中状态：进程内瞬态去重（镜像 compaction 的 inFlight），重启自然归零。
const consolidatingConversations = new Set<string>();

/** 仅供测试：清空整理运行时态。 */
export function __resetConsolidationRuntime(): void {
  consolidatingConversations.clear();
}

/**
 * 轮后 fire-and-forget：每 everyN 个 assistant 轮跑一次。读水位线后的对话切片 + 现有记忆全库，
 * 结构化单发产出操作清单，确定性落库，推进 memoryThroughSeq；有变更才通知。失败/未配模型/会话被删
 * 一律 warn 并保持原状（下轮重试），绝不阻塞发送。门控双闸：memoryEnabled + memoryAutoConsolidate。
 */
export async function maybeConsolidateMemory(
  deps: ConsolidationDeps,
  conversationId: string,
  bookId: string | null,
  everyN = MEMORY_PASS_EVERY_N_TURNS,
): Promise<void> {
  const { db, resolveModel, runBackground, notify } = deps;

  // 门控双闸
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  if (!memoryEnabled) return;
  const auto = getPreference(db, "memoryAutoConsolidate") ?? false;
  if (!auto) return;

  if (consolidatingConversations.has(conversationId)) return; // 并发去重

  const convo = db
    .select({ through: conversations.memoryThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!convo) return; // 会话已删

  const through = convo.through ?? null;
  const tail = listMessagesAfterSeq(db, conversationId, through);
  const assistantTurns = tail.filter((m) => m.role === "assistant").length;
  if (assistantTurns < everyN) return; // 未到阈值

  const resolved = resolveModel();
  if (!resolved.ok) {
    log.warn("summary model not configured; skip consolidation", resolved.reason);
    return;
  }

  consolidatingConversations.add(conversationId);
  try {
    const memories = listMemories(db);
    const input = renderMemoryPassInput(tail, memories);
    const { object } = await runBackground(() =>
      generateObject({
        model: resolved.model,
        schema: memoryPassOutput,
        system: CONSOLIDATION_SYSTEM,
        prompt: input,
        maxOutputTokens: MEMORY_PASS_MAX_TOKENS,
        maxRetries: 1,
      }),
    );

    // 写回前复查会话仍在（整理中途被删 → 丢弃；better-sqlite3 同步驱动，check-then-act 安全）
    const still = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!still) {
      log.debug("conversation deleted mid-consolidation; drop", conversationId);
      return;
    }

    const applied = applyMemoryOps(db, object.ops, { sourceBookId: bookId });
    const latestSeq = tail.at(-1)?.seq ?? through ?? 0;
    db.update(conversations)
      .set({ memoryThroughSeq: latestSeq })
      .where(eq(conversations.id, conversationId))
      .run();

    const total = applied.saved + applied.updated + applied.deleted;
    if (total > 0) {
      notify({
        kind: "memoryConsolidated",
        saved: applied.saved,
        updated: applied.updated,
        deleted: applied.deleted,
      });
    }
    log.debug(
      `consolidation done conv=${conversationId} saved=${applied.saved} updated=${applied.updated} deleted=${applied.deleted}`,
    );
  } catch (err) {
    log.warn(`conversation ${conversationId} consolidation failed`, err);
  } finally {
    consolidatingConversations.delete(conversationId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/ai/memory-consolidation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/memory-consolidation.ts src/main/ai/memory-consolidation.test.ts
git commit -m "feat(ai): add maybeConsolidateMemory background pass orchestrator"
```

---

## Task 7: `notifyRenderer` glue + wire into send path

**Files:**

- Create: `src/main/notify.ts`
- Modify: `src/main/ai/send.ts` (`SendDeps`)
- Modify: `src/main/ai/send-deps.ts` (`makeSendDeps`)
- Modify: `src/main/ai/stream-assistant.ts` (`onFinish`)

This task is wiring; its behavioral seam (`maybeConsolidateMemory` with an injected `notify`) is already covered by Task 6. Verification is `pnpm typecheck` + the full suite.

- [ ] **Step 1: Create the notify glue**

Create `src/main/notify.ts`:

```ts
// src/main/notify.ts —— main→renderer 通知的唯一 Electron 触点（spec 2026-06-16 §4.3）。
import { BrowserWindow } from "electron";
import { C } from "@shared/ipc";
import type { AppNotification } from "@shared/chat";

/** 向所有窗口广播一条通知（单窗口 app 即发给那一个）；窗口已销毁则跳过。 */
export function notifyRenderer(n: AppNotification): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(C.appNotify.channel, n);
  }
}
```

- [ ] **Step 2: Add the `notify` port to `SendDeps`**

In `src/main/ai/send.ts`, add the import and the field. Extend the existing `@shared/chat` import:

```ts
import { type ResendInput, type SendInput } from "@shared/chat";
import type { AppNotification } from "@shared/chat";
```

Add to the `SendDeps` interface, after `stepLimit`:

```ts
  /** agent 多步上限（默认 DEFAULT_STEP_LIMIT=10）；0 = 不限制（永不主动刹车，靠模型自然停止 + abort）。 */
  stepLimit?: number;
  /** main→renderer 通知端口（后台记忆整理完成的 toast）。 */
  notify: (n: AppNotification) => void;
```

- [ ] **Step 3: Inject `notifyRenderer` in the production factory**

In `src/main/ai/send-deps.ts`, add the import:

```ts
import { notifyRenderer } from "@main/notify";
```

Add `notify` to the returned object in `makeSendDeps()`:

```ts
    runBackground: backgroundLimiter.run,
    stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT,
    notify: notifyRenderer,
  };
```

- [ ] **Step 4: Call the pass from `onFinish`**

In `src/main/ai/stream-assistant.ts`:

(a) Add the import next to the existing `maybeCompactConversation` import:

```ts
import { maybeCompactConversation } from "@main/ai/context-compaction";
import { maybeConsolidateMemory } from "@main/ai/memory-consolidation";
```

(b) Add `notify` to the deps destructure near the top of `streamAssistantReply`:

```ts
const { db, loadBytes, resolveSummaryModel, stepLimit, runBackground, notify } = deps;
```

(c) In the `onFinish` callback's `status === "complete"` branch, immediately after the existing `void maybeCompactConversation(...)` call, add:

```ts
void maybeCompactConversation(
  { db, resolveModel: resolveSummaryModel, runBackground },
  conversationId,
);
void maybeConsolidateMemory(
  { db, resolveModel: resolveSummaryModel, runBackground, notify },
  conversationId,
  bookId,
);
```

(`bookId` is already destructured from `ctx` at the top of `streamAssistantReply`.)

- [ ] **Step 5: Fix any other `SendDeps` construction sites**

`notify` is now required on `SendDeps`. Run typecheck to find any test/helper that builds a `SendDeps` literal and is now missing `notify`:

Run: `pnpm typecheck`
Expected: errors ONLY at `SendDeps` literals missing `notify` (e.g. in `send.test.ts` / `send-deps.test.ts` / `stream-assistant` tests). For each, add `notify: () => {}` (a no-op spy) to the literal. Re-run until green.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/notify.ts src/main/ai/send.ts src/main/ai/send-deps.ts src/main/ai/stream-assistant.ts src/main/ai
git commit -m "feat(ai): wire background memory consolidation into the send path"
```

---

## Task 8: preload `app.onNotify`

**Files:**

- Modify: `src/preload-api.ts`
- Test: `src/preload-api.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/preload-api.test.ts`:

```ts
describe("app.onNotify", () => {
  it("subscribes to the app:notify channel and forwards payloads", () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const api = createApi({
      invoke: async () => undefined,
      on: (channel, cb) => {
        handlers.set(channel, cb);
        return () => handlers.delete(channel);
      },
      getPathForFile: () => "",
      prefsSnapshot: {},
      appLocale: "en",
    });
    const received: unknown[] = [];
    const unsub = api.app.onNotify((n) => received.push(n));
    handlers.get("app:notify")?.({ kind: "memoryConsolidated", saved: 1, updated: 0, deleted: 0 });
    expect(received).toEqual([{ kind: "memoryConsolidated", saved: 1, updated: 0, deleted: 0 }]);
    unsub();
    expect(handlers.has("app:notify")).toBe(false);
  });
});
```

> Mirror the existing `createApi(...)` construction in this test file if its `PreloadDeps` shape differs (e.g. additional fields). `createApi` and any imports it needs are already imported at the top of this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/preload-api.test.ts -t onNotify`
Expected: FAIL — `api.app.onNotify is not a function`.

- [ ] **Step 3: Add `AppNotification` import + `onNotify` to the `app` surface**

In `src/preload-api.ts`, extend the `@shared/chat` import:

```ts
import type { AiStreamEvent, AppNotification } from "@shared/chat";
```

In `createApi`, add `onNotify` to the `app` object (alongside `getInfo` / `locale` / `openLogsDir` / `openExternal` / `checkUpdate`):

```ts
    app: {
      getInfo: inv(C.appGetInfo),
      locale: d.appLocale,
      openLogsDir: inv(C.appOpenLogsDir),
      openExternal: inv(C.appOpenExternal),
      checkUpdate: inv(C.appCheckUpdate),
      /** 订阅 main→renderer 通知；返回退订函数。 */
      onNotify: (cb: (n: AppNotification) => void): (() => void) =>
        d.on(C.appNotify.channel, (payload) => cb(payload as AppNotification)),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/preload-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload-api.ts src/preload-api.test.ts
git commit -m "feat(preload): expose app.onNotify subscriber"
```

---

## Task 9: Renderer notification → toast

**Files:**

- Create: `src/renderer/notifications/app-notifications.ts`
- Create: `src/renderer/notifications/app-notifications.test.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/notifications/app-notifications.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { notificationMessage } from "@renderer/notifications/app-notifications";

// 假 t：回显 fallback 文案 + 插值，足够断言「有内容/无内容」。
const t = ((_key: string, fallback: string, vars?: Record<string, unknown>) =>
  vars
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k]))
    : fallback) as unknown as Parameters<typeof notificationMessage>[1];

describe("notificationMessage", () => {
  it("formats a memoryConsolidated notification with counts", () => {
    const msg = notificationMessage(
      { kind: "memoryConsolidated", saved: 2, updated: 1, deleted: 0 },
      t,
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("2");
    expect(msg).toContain("1");
  });

  it("returns null when nothing changed", () => {
    const msg = notificationMessage(
      { kind: "memoryConsolidated", saved: 0, updated: 0, deleted: 0 },
      t,
    );
    expect(msg).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/notifications/app-notifications.test.ts`
Expected: FAIL — cannot find module `@renderer/notifications/app-notifications`.

- [ ] **Step 3: Implement the formatter + hook**

Create `src/renderer/notifications/app-notifications.ts`:

```ts
import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AppNotification } from "@shared/chat";

/** 纯函数：把通知本地化成 toast 文案；无可展示内容返回 null。 */
export function notificationMessage(n: AppNotification, t: TFunction): string | null {
  switch (n.kind) {
    case "memoryConsolidated": {
      if (n.saved + n.updated + n.deleted <= 0) return null;
      return t("notify.memoryConsolidated", "Lia 整理了记忆 · 新增 {{saved}} · 更新 {{updated}}", {
        saved: n.saved,
        updated: n.updated,
      });
    }
    default:
      return null;
  }
}

/** 订阅 main→renderer 通知，本地化后弹轻 toast。App 挂载时调用一次。 */
export function useAppNotifications(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (typeof window === "undefined" || !window.api?.app?.onNotify) return;
    const unsub = window.api.app.onNotify((n) => {
      const msg = notificationMessage(n, t);
      if (msg) toast(msg);
    });
    return unsub;
  }, [t]);
}
```

- [ ] **Step 4: Mount the hook in App**

In `src/renderer/App.tsx`, add the import and call it inside `App` (after `useStartupUpdateCheck()`):

```ts
import { useAppNotifications } from "@renderer/notifications/app-notifications";
```

```ts
useStartupUpdateCheck();
useAppNotifications();
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test src/renderer/notifications/app-notifications.test.ts && pnpm typecheck`
Expected: PASS. (If typecheck flags `window.api.app.onNotify` as unknown, the `RendererApi` type from Task 8 already includes it — ensure Task 8 is committed.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/notifications src/renderer/App.tsx
git commit -m "feat(renderer): show a toast on background memory consolidation"
```

---

## Task 10: Settings toggle + store + hydrate + i18n

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`
- Modify: `src/renderer/settings/MemorySettings.tsx`
- Modify: `src/shared/i18n/locales/*` (via extract)

- [ ] **Step 1: Add state + action to the prefs store**

In `src/renderer/store/prefs-store.ts`:

(a) In `interface PrefsState`, after the `memoryEnabled` field:

```ts
/** AI 记忆功能总开关（默认开）。 */
memoryEnabled: boolean;
/** 后台每 N 轮自动整理记忆（默认关——控成本；受 memoryEnabled 总闸约束）。 */
memoryAutoConsolidate: boolean;
```

(b) In `interface PrefsActions`, after `setMemoryEnabled`:

```ts
  setMemoryEnabled: (v: boolean) => void;
  setMemoryAutoConsolidate: (v: boolean) => void;
```

(c) In `PREFS_INITIAL`, after `memoryEnabled: true,`:

```ts
  memoryEnabled: true,
  memoryAutoConsolidate: false,
```

(d) In the store creator, after the `setMemoryEnabled` action:

```ts
  setMemoryAutoConsolidate: (memoryAutoConsolidate) => {
    persistPreference({ key: "memoryAutoConsolidate", value: memoryAutoConsolidate });
    set({ memoryAutoConsolidate });
  },
```

- [ ] **Step 2: Hydrate the new preference**

In `src/renderer/store/hydrate-preferences.ts`, after the `memoryEnabled` block:

```ts
if (snap.memoryEnabled !== undefined) {
  usePrefsStore.setState({ memoryEnabled: snap.memoryEnabled });
}
if (snap.memoryAutoConsolidate !== undefined) {
  usePrefsStore.setState({ memoryAutoConsolidate: snap.memoryAutoConsolidate });
}
```

- [ ] **Step 3: Add the toggle to MemorySettings**

In `src/renderer/settings/MemorySettings.tsx`:

(a) Read the new state/action next to the existing memory-enabled lines:

```ts
const memoryEnabled = usePrefsStore((s) => s.memoryEnabled);
const setMemoryEnabled = usePrefsStore((s) => s.setMemoryEnabled);
const memoryAutoConsolidate = usePrefsStore((s) => s.memoryAutoConsolidate);
const setMemoryAutoConsolidate = usePrefsStore((s) => s.setMemoryAutoConsolidate);
```

(b) Immediately after the existing "总开关" `<div>...</div>` block (the one containing `id="memory-enabled"`), add a second toggle, disabled when memory is off:

```tsx
{
  /* 后台自动整理开关（受总开关约束） */
}
<div className="flex items-start justify-between gap-3">
  <label htmlFor="memory-auto-consolidate" className="min-w-0 cursor-pointer">
    <span className="block text-sm font-medium">
      {t("settings.memory.autoConsolidate", "后台自动整理记忆")}
    </span>
    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
      {t(
        "settings.memory.autoConsolidateDesc",
        "每隔几轮对话，Lia 会在后台补记漏掉的要点并整理已有记忆。会产生额外的模型调用，默认关闭。",
      )}
    </span>
  </label>
  <Checkbox
    id="memory-auto-consolidate"
    checked={memoryAutoConsolidate}
    onCheckedChange={setMemoryAutoConsolidate}
    disabled={!memoryEnabled}
    className="mt-0.5"
  />
</div>;
```

- [ ] **Step 4: Extract i18n keys**

Run: `pnpm i18n:extract`
Expected: `notify.memoryConsolidated`, `settings.memory.autoConsolidate`, `settings.memory.autoConsolidateDesc` appear in `src/shared/i18n/locales/zh-CN.ts` (primary). Then translate them in `en.ts` (and any other locale) — write natural English, e.g.:

- `notify.memoryConsolidated`: `"Lia tidied your memories · +{{saved}} · ~{{updated}}"`
- `settings.memory.autoConsolidate`: `"Auto-consolidate memory in the background"`
- `settings.memory.autoConsolidateDesc`: `"Every few turns, Lia catches up on points it missed and tidies existing memories in the background. This makes extra model calls and is off by default."`

- [ ] **Step 5: Verify i18n + typecheck**

Run: `pnpm i18n:lint && pnpm typecheck`
Expected: PASS (no missing keys; types resolve).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts src/renderer/settings/MemorySettings.tsx src/shared/i18n/locales
git commit -m "feat(settings): add background memory consolidation toggle"
```

---

## Task 11: Full verification + changeset

**Files:**

- Create: `.changeset/<name>.md`

- [ ] **Step 1: Run the whole suite + checks**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:lint`
Expected: all PASS. Fix anything red before continuing.

- [ ] **Step 2: Manual smoke (the only path the headless suite cannot cover)**

Run the app, then:

1. Configure a chat model + summary model (Settings) if not already.
2. Settings → 记忆 → turn ON "后台自动整理记忆".
3. Open a book, start a conversation, and exchange at least 5 assistant turns mentioning a durable preference (e.g. "I always read sci-fi before bed").
4. Expect a low-key toast ("Lia 整理了记忆 …") to appear after the 5th turn, and a new entry under Settings → 记忆 list.
5. Toggle the switch OFF, exchange 5 more turns → no toast, no new memory.

Launch via the `run` skill or `pnpm start` with an isolated `--user-data-dir=/tmp/marg-smoke` to avoid touching real userData.

- [ ] **Step 3: Write the changeset**

Run: `pnpm changeset` and write a user-facing English entry, e.g.:

> Added an optional background pass that periodically catches up on memories the assistant missed and tidies existing ones, with a low-key toast when it runs. Off by default — enable it under Settings → Memory.

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for background memory consolidation"
```

---

## Self-Review Notes (for the planner)

- **Spec coverage:** §2 trigger/watermark → Tasks 1, 6, 7. §3 ops + apply + delete-constraint → Tasks 4, 6 (prompt). §4 notification channel → Tasks 2, 7, 8, 9. §5 model/concurrency/gating → Task 6 (gating + summaryModel + runBackground) and Task 3 (preference). §6 module list → all tasks. §7 error handling → Task 6 tests (unconfigured model, deleted conversation re-check, empty ops). §8 testing → Tasks 1–9 tests. §9 YAGNI (N constant, no staleness delete, no action toast) → honored.
- **Type consistency:** `applyMemoryOps` / `renderMemoryPassInput` / `maybeConsolidateMemory` / `ConsolidationDeps` / `AppNotification` / `notifyRenderer` / `notificationMessage` / `useAppNotifications` names are used identically across tasks. `memoryPassOutput` is the schema fed to `generateObject`. `MEMORY_PASS_EVERY_N_TURNS` default flows from constant → orchestrator param → production call.
- **No staleness delete:** enforced only by the system prompt (Task 6); `applyMemoryOps` itself executes whatever `delete` ops arrive — acceptable per spec (the model is the gate; tests cover that delete works mechanically).
