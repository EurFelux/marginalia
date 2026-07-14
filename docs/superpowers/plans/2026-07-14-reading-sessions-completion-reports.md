# Reading Sessions and Completion Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit reading sessions, session-aware reading time, and editable AI-generated completion reports written by the reader's configured assistant from the reader's traces and durable memory.

**Architecture:** Introduce `reading_sessions` as the durable lifecycle boundary while keeping `reading_daily` as the only reading-time fact table. Main-process repositories own session state, evidence queries, report generation, staged memory writes, and AI tools; shared Zod contracts drive IPC; renderer routes a book to start, active-reader, reference-reader, or completion-report views from derived session state. Report generation reads live assistant preferences without changing chat snapshots, commits report and memory changes together, and never reloads raw conversation messages at or before a persisted compaction boundary.

**Tech Stack:** Electron 41.7.1, TypeScript 6, React 19 with React Compiler, Zustand, TanStack Query, Zod 4, Drizzle ORM 1.0.0-rc.3, SQLite/better-sqlite3, Vercel AI SDK 7, Vitest 4, Tailwind CSS 4, CodeMirror 6, Streamdown.

## Global Constraints

- Keep all business logic in `src/main/`; renderer code only displays shared DTOs and invokes IPC.
- Use the configured summary model for report generation; never fall back to the chat model.
- Build report context from the current SOUL, reader instructions, memory setting, and memory index on every generation or regeneration; do not use a conversation snapshot.
- Default to the assistant's first-person perspective addressing the reader as “you”; reader instructions may override writing style, perspective, structure, and content, but not evidence or tool boundaries.
- Expose only `readMemory`, `saveMemory`, and `updateMemory` to the report agent. Stage writes and commit them in the same transaction as the final report; never expose `deleteMemory` or `updateSoul`.
- Never return raw conversation messages with `seq <= summarizedThroughSeq`; paginate and text-budget the uncompacted tail.
- Persist only final non-empty Markdown in `reading_sessions.report`; do not persist partial output, tool traces, provenance, or report versions.
- Derive reading state from session timestamps; do not add a session `status` column.
- Use `Temporal` for every new timestamp read or calendar calculation. Read the system clock only in Electron glue and inject it into pure functions.
- Keep `reading_daily` as the sole reading-time fact table. Do not add `active_seconds` to `reading_sessions`.
- Generate Drizzle migrations with `pnpm db:generate`; do not hand-edit generated `migration.sql` or `snapshot.json`.
- Use `createLogger`; swallowed or degraded failures must log at `warn`, and no new diagnostic path may use bare `console.*`.
- Use Tailwind classes for static UI styling; inline styles remain limited to runtime-calculated values.
- Do not hand-write `useMemo` or `useCallback`; React Compiler handles memoization.
- Add no dependencies. Reuse the existing Markdown editor, Streamdown renderer, dialogs, selects, and buttons.
- Every user-visible string goes through `t()` with a Chinese default, then `pnpm i18n:extract` synchronizes locale files.

---

## File and Interface Map

### New shared and main-process files

- `src/shared/reading-sessions.ts` — Zod inputs, reading-state enum, session DTOs, report-state discriminated unions, and generation result.
- `src/main/reading-sessions/repository.ts` — start/complete lifecycle, session lookup/listing, report persistence, state derivation, and session-time projection.
- `src/main/reading-sessions/repository.test.ts` — lifecycle and database-constraint coverage.
- `src/main/ipc/reading-sessions-handlers.ts` — Electron glue for lifecycle, report reads/writes, and generation.
- `src/main/reading-report/evidence.ts` — session-window evidence queries and zero-evidence preflight.
- `src/main/reading-report/evidence.test.ts` — timestamp-window and conversation-neighbor tests.
- `src/main/reading-report/tools.ts` — target-scoped report-agent tools.
- `src/main/reading-report/tools.test.ts` — tool scope, pagination, and previous-report tests.
- `src/main/reading-report/agent.ts` — bounded AI SDK agent loop and reader-centered prompt.
- `src/main/reading-report/runtime.ts` — in-memory generating/failed state mapped to the six report DTO variants.
- `src/main/reading-report/service.ts` — preflight, deduplication, background execution, and atomic report replacement.
- `src/main/reading-report/service.test.ts` — runtime, failure, restart, and atomicity tests.
- `src/main/reading-report/prompt.ts` — live report-specific composition of core rules, SOUL, memory index, and reader instructions.
- `src/main/reading-report/prompt.test.ts` — perspective, precedence, live preference, and memory-gating tests.
- `src/main/reading-report/memory-workspace.ts` — in-memory overlay and report-scoped read/save/update tools.
- `src/main/reading-report/memory-workspace.test.ts` — overlay reads, mutation collapse, tool scope, and memory gating tests.
- `src/main/ai/reading-session-tools.ts` — normal chat tools `listReadingSessions` and `getReadingReport`.
- `src/main/ai/reading-session-tools.test.ts` — reader/library scope and cross-book isolation tests.
- `src/main/db/migrate-reading-sessions.test.ts` — real legacy-data migration preservation test.

### New renderer files

- `src/renderer/reading/BookRoute.tsx` — fetch a book and choose start, active reader, reference reader, or report view.
- `src/renderer/reading/route-state.ts` — pure destination resolver for headless tests.
- `src/renderer/reading/route-state.test.ts` — exhaustive route-state coverage.
- `src/renderer/reading/ReadingStartView.tsx` — explicit start ritual.
- `src/renderer/reading/CompleteReadingDialog.tsx` — confirmation and completion mutation.
- `src/renderer/reading/ReadingReportView.tsx` — layout A completion page and session history selector.
- `src/renderer/reading/ReportEditor.tsx` — CodeMirror edit/save surface.
- `src/renderer/reading/report-view-model.ts` — exhaustive report-state-to-UI projection.
- `src/renderer/reading/report-view-model.test.ts` — all six report-state branches.
- `src/renderer/query/reading-session-queries.ts` — session list/detail query options and generation polling.

### Existing files changed across tasks

- Data: `src/main/db/schema.ts`, generated migration directories under `src/main/db/migrations/`.
- Timing: `src/main/stats/reading-daily.ts`, `src/main/stats/clock-wiring.ts`, and their tests.
- Library state: `src/main/library/repository.ts`, `src/main/ipc/library-handlers.ts`, `src/shared/library.ts`, and their tests.
- IPC spine: `src/shared/ipc.ts`, `src/preload-api.ts`, `src/preload-api.test.ts`, `src/main/ipc/bindings-coverage.test.ts`, `src/main.ts`.
- AI composition: `src/main/ai/context-tools.ts`, `src/main/ai/context-tools.test.ts`, `src/main/ai/library-tools.ts`, `src/main/ai/library-tools.test.ts`, `src/main/ai/send-deps.ts`.
- Navigation/reader: `src/renderer/App.tsx`, `src/renderer/store/navigation-store.ts`, `src/renderer/store/navigation-store.test.ts`, `src/renderer/reader/ReaderView.tsx`, `src/renderer/reader/EpubReader.tsx`, `src/renderer/reader/PdfReader.tsx`, `src/renderer/reader/use-reading-clock.ts`.
- Library UI: `src/renderer/library/LibraryView.tsx`, `src/renderer/library/BookCover.tsx`, `src/renderer/library/SortableBook.tsx`, `src/renderer/library/CoverImage.tsx`, `src/renderer/library/RecentlyReadShelf.tsx`.
- Query/i18n: `src/renderer/query/keys.ts`, `src/shared/i18n/locales/zh-CN.ts`, `src/shared/i18n/locales/en.ts`.

---

### Task 1: Add Reading Session Persistence and Lifecycle IPC

**Files:**

- Create: `src/shared/reading-sessions.ts`
- Create: `src/main/reading-sessions/repository.ts`
- Create: `src/main/reading-sessions/repository.test.ts`
- Create: `src/main/ipc/reading-sessions-handlers.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload-api.ts`
- Modify: `src/preload-api.test.ts`
- Modify: `src/main/ipc/bindings-coverage.test.ts`
- Modify: `src/main.ts`
- Generated: `src/main/db/migrations/*_reading_sessions/migration.sql`
- Generated: `src/main/db/migrations/*_reading_sessions/snapshot.json`

**Interfaces:**

- Produces: `BookReadingState`, `ReadingSessionSummaryDto`, `ReadingReportState`, `startReading()`, `completeReading()`, `getActiveReadingSession()`, `listReadingSessions()`, `getReadingSession()`, `saveReadingReport()`, and `readingSessionBindings`.
- Consumes: existing `DB`, `books`, `progress`, `readingDaily`, IPC `bind/register`, and `getReadingClock()`.

- [ ] **Step 1: Write shared-contract tests before the schemas exist**

Add cases to `src/shared/library.test.ts` or a new describe block imported from `@shared/reading-sessions`:

```ts
it("parses start-reading modes as a discriminated union", () => {
  expect(startReadingInput.parse({ mode: "continue", bookId: "b1" })).toEqual({
    mode: "continue",
    bookId: "b1",
  });
  expect(startReadingInput.parse({ mode: "restart", bookId: "b1" })).toEqual({
    mode: "restart",
    bookId: "b1",
  });
  expect(startReadingInput.safeParse({ mode: "continue", bookId: "" }).success).toBe(false);
});

it("requires content only in report states that preserve a report", () => {
  expect(readingReportStateSchema.parse({ status: "empty" })).toEqual({ status: "empty" });
  expect(readingReportStateSchema.safeParse({ status: "regenerating", content: "" }).success).toBe(
    false,
  );
  expect(
    readingReportStateSchema.parse({
      status: "regeneration-failed",
      content: "# Kept",
      reason: "offline",
    }),
  ).toEqual({ status: "regeneration-failed", content: "# Kept", reason: "offline" });
});
```

- [ ] **Step 2: Write lifecycle and constraint tests**

Create `src/main/reading-sessions/repository.test.ts` with a migrated in-memory DB and fixed `Temporal.Instant` values. Cover these exact behaviors:

```ts
it("allows many completed sessions but only one active session per book", () => {
  const first = startReading(db, {
    bookId: "b1",
    mode: "continue",
    startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
  });
  completeReading(db, "b1", Temporal.Instant.from("2026-07-03T00:00:00Z"));
  const second = startReading(db, {
    bookId: "b1",
    mode: "restart",
    startedAt: Temporal.Instant.from("2026-07-10T00:00:00Z"),
  });
  expect(first.id).not.toBe(second.id);
  expect(() =>
    startReading(db, {
      bookId: "b1",
      mode: "continue",
      startedAt: Temporal.Instant.from("2026-07-11T00:00:00Z"),
    }),
  ).toThrow(/already has an active reading session/);
});

it("preserves progress for continue and clears it for restart", () => {
  saveProgress(db, "b1", "epubcfi(/6/2)", 0.6);
  startReading(db, {
    bookId: "b1",
    mode: "continue",
    startedAt: Temporal.Instant.from("2026-07-01T00:00:00Z"),
  });
  expect(getProgress(db, "b1")?.percent).toBe(0.6);
  completeReading(db, "b1", Temporal.Instant.from("2026-07-02T00:00:00Z"));
  startReading(db, {
    bookId: "b1",
    mode: "restart",
    startedAt: Temporal.Instant.from("2026-07-03T00:00:00Z"),
  });
  expect(getProgress(db, "b1")).toBeUndefined();
});
```

Also assert that completed time before started time fails, an active session cannot store a report, a completed session can store trimmed non-empty Markdown, deleting a book cascades sessions, and `restart` is rejected when the book has never completed a session.

- [ ] **Step 3: Run the new tests and verify the expected failure**

Run:

```bash
pnpm test src/main/reading-sessions/repository.test.ts src/shared/library.test.ts
```

Expected: FAIL because `@shared/reading-sessions` and `@main/reading-sessions/repository` do not exist.

- [ ] **Step 4: Define the shared discriminated unions and DTOs**

Create `src/shared/reading-sessions.ts` with these public contracts:

```ts
import { z } from "zod";

export const bookReadingStateSchema = z.enum(["not-started", "reading", "finished"]);
export type BookReadingState = z.infer<typeof bookReadingStateSchema>;

export const startReadingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("continue"), bookId: z.string().min(1) }),
  z.object({ mode: z.literal("restart"), bookId: z.string().min(1) }),
]);
export type StartReadingInput = z.infer<typeof startReadingInput>;

export const completeReadingInput = z.object({ bookId: z.string().min(1) });
export const readingSessionIdInput = z.object({ sessionId: z.string().min(1) });
export const listReadingSessionsInput = z.object({ bookId: z.string().min(1) });
export const saveReadingReportInput = z.object({
  sessionId: z.string().min(1),
  content: z.string().trim().min(1),
});

const markdown = z.string().trim().min(1);
export const readingReportStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("generating") }),
  z.object({ status: z.literal("generation-failed"), reason: z.string().min(1) }),
  z.object({ status: z.literal("ready"), content: markdown }),
  z.object({ status: z.literal("regenerating"), content: markdown }),
  z.object({
    status: z.literal("regeneration-failed"),
    content: markdown,
    reason: z.string().min(1),
  }),
]);
export type ReadingReportState = z.infer<typeof readingReportStateSchema>;

export const generateReadingReportResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({ outcome: z.literal("insufficient-evidence") }),
]);
export type GenerateReadingReportResult = z.infer<typeof generateReadingReportResultSchema>;

export interface ReadingSessionSummaryDto {
  id: string;
  bookId: string;
  startedAt: number;
  completedAt: number | null;
  activeSeconds: number;
  reportAvailable: boolean;
}

export interface ReadingSessionDetailDto {
  session: ReadingSessionSummaryDto;
  report: ReadingReportState;
}
```

- [ ] **Step 5: Add the initial database shape and generate its migration**

In `src/main/db/schema.ts`, add `readingSessions` after `books`, and add nullable `readingSessionId` to `readingDaily` while retaining the old `(book_id, day)` unique index during this compatibility phase:

```ts
export const readingSessions = sqliteTable(
  "reading_sessions",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    report: text("report"),
  },
  (t) => [
    check(
      "reading_sessions_completed_after_start_check",
      sql`${t.completedAt} is null or ${t.completedAt} >= ${t.startedAt}`,
    ),
    check(
      "reading_sessions_report_requires_completion_check",
      sql`${t.report} is null or ${t.completedAt} is not null`,
    ),
    uniqueIndex("reading_sessions_one_active_per_book")
      .on(t.bookId)
      .where(sql`${t.completedAt} is null`),
    index("reading_sessions_book_id_idx").on(t.bookId),
  ],
);
```

Add the FK column:

```ts
readingSessionId: text("reading_session_id").references(() => readingSessions.id, {
  onDelete: "set null",
}),
```

Run:

```bash
pnpm db:generate --name reading_sessions
```

Expected: a generated `*_reading_sessions` directory containing `migration.sql` and `snapshot.json`; inspect but do not edit either file.

- [ ] **Step 6: Implement the lifecycle repository**

Create `src/main/reading-sessions/repository.ts`. Use `Temporal.Instant.epochMilliseconds` only at the persistence boundary and expose these exact signatures:

```ts
export type ReadingSessionRow = typeof readingSessions.$inferSelect;

export function getReadingSession(db: DB, sessionId: string): ReadingSessionRow | undefined;
export function getActiveReadingSession(db: DB, bookId: string): ReadingSessionRow | undefined;
export function listReadingSessionRows(db: DB, bookId: string): ReadingSessionRow[];
export function listReadingSessions(db: DB, bookId: string): ReadingSessionSummaryDto[];
export function getBookReadingState(db: DB, bookId: string): BookReadingState;
export function startReading(
  db: DB,
  input: StartReadingInput & { startedAt: Temporal.Instant },
): ReadingSessionRow;
export function completeReading(
  db: DB,
  bookId: string,
  completedAt: Temporal.Instant,
): ReadingSessionRow;
export function saveReadingReport(db: DB, sessionId: string, content: string): ReadingSessionRow;
export function readingSessionSeconds(db: DB, sessionId: string): number;
export function toReadingSessionSummary(db: DB, row: ReadingSessionRow): ReadingSessionSummaryDto;
```

Implementation rules:

- `startReading` runs in one transaction, verifies the book, rejects an existing active session, requires at least one completed session for `restart`, deletes `progress` only for `restart`, and inserts the new row.
- `completeReading` finds the active row for the book and updates only that row.
- `saveReadingReport` trims, rejects empty content, and rejects an active or missing session before updating.
- `getBookReadingState` returns `reading` when an active row exists, `finished` when completed rows exist without an active row, and `not-started` otherwise.
- `readingSessionSeconds` sums `reading_daily.seconds` by the nullable FK and returns zero for no rows.
- `toReadingSessionSummary` derives `reportAvailable` from trimmed report content and never returns the report body.

- [ ] **Step 7: Add lifecycle IPC contracts, bindings, and preload exposure**

Add to `C` in `src/shared/ipc.ts`:

```ts
readingSessionsStart: def(
  "reading-sessions:start",
  "invoke",
  startReadingInput,
  out<ReadingSessionSummaryDto>(),
),
readingSessionsComplete: def(
  "reading-sessions:complete",
  "invoke",
  completeReadingInput,
  out<ReadingSessionSummaryDto>(),
),
readingSessionsList: def(
  "reading-sessions:list",
  "invoke",
  listReadingSessionsInput,
  out<ReadingSessionSummaryDto[]>(),
),
```

Create `src/main/ipc/reading-sessions-handlers.ts` with glue that reads `Temporal.Now.instant()` and, before completing, calls `getReadingClock().setReadingBook(null)` so the old clock is flushed before `completed_at` changes. Export `readingSessionBindings` and `registerReadingSessionHandlers()`.

Expose these under `window.api.readingSessions` in `src/preload-api.ts`:

```ts
readingSessions: {
  start: inv(C.readingSessionsStart),
  complete: inv(C.readingSessionsComplete),
  list: inv(C.readingSessionsList),
},
```

Register the handler in `src/main.ts`, add its bindings to `src/main/ipc/bindings-coverage.test.ts`, and leave no new main-only exception in `src/preload-api.test.ts`.

- [ ] **Step 8: Run focused and contract tests**

Run:

```bash
pnpm test src/main/reading-sessions/repository.test.ts src/shared/library.test.ts src/main/ipc/bindings-coverage.test.ts src/preload-api.test.ts
pnpm typecheck
```

Expected: all commands PASS while the existing `books.isFinished` UI behavior remains intact.

- [ ] **Step 9: Commit the persistence slice**

```bash
git add src/shared/reading-sessions.ts src/main/reading-sessions src/main/ipc/reading-sessions-handlers.ts src/main/db/schema.ts src/main/db/migrations src/shared/ipc.ts src/preload-api.ts src/preload-api.test.ts src/main/ipc/bindings-coverage.test.ts src/main.ts src/shared/library.test.ts
git commit -m "feat: add reading session lifecycle"
```

---

### Task 2: Add Session-Window Evidence Queries and Report Tools

**Files:**

- Create: `src/main/reading-report/evidence.ts`
- Create: `src/main/reading-report/evidence.test.ts`
- Create: `src/main/reading-report/tools.ts`
- Create: `src/main/reading-report/tools.test.ts`
- Modify: `src/main/chat/messages.ts`

**Interfaces:**

- Consumes: `ReadingSessionRow`, annotations, book notes, conversations/messages, existing `createReadingTools()`, and session summaries.
- Produces: `hasReaderEvidence()`, timestamp-scoped query functions, and `createReadingReportTools()`.

- [ ] **Step 1: Write evidence-window tests**

Create fixtures with one completed session from `2026-07-01T00:00:00Z` through `2026-07-10T00:00:00Z`. Insert annotations, notes, and messages before, inside, and after that range. Assert:

```ts
expect(listSessionAnnotations(db, session)).toEqual([
  expect.objectContaining({ selectedText: "created inside" }),
  expect.objectContaining({ selectedText: "updated inside" }),
]);
expect(listSessionBookNotes(db, session)).toEqual([
  expect.objectContaining({ content: "changed during this reading" }),
]);
expect(listSessionConversations(db, session).map((c) => c.id)).toEqual(["conversation-in-window"]);
```

For `readSessionConversation`, assert it returns all in-window messages plus at most one immediate neighbor before and after, ordered by `seq`, and rejects a conversation from another book.

- [ ] **Step 2: Run the evidence tests and verify failure**

Run:

```bash
pnpm test src/main/reading-report/evidence.test.ts
```

Expected: FAIL because `evidence.ts` does not exist.

- [ ] **Step 3: Implement timestamp-scoped evidence queries**

Create `src/main/reading-report/evidence.ts` with these signatures:

```ts
export function listSessionAnnotations(db: DB, session: ReadingSessionRow): AnnotationDto[];
export function listSessionBookNotes(db: DB, session: ReadingSessionRow): BookNoteDto[];
export function listSessionConversations(
  db: DB,
  session: ReadingSessionRow,
): SessionConversationSummary[];
export function readSessionConversation(
  db: DB,
  session: ReadingSessionRow,
  conversationId: string,
): SessionMessageExcerpt[];
export function hasReaderEvidence(db: DB, session: ReadingSessionRow): boolean;
```

Use the inclusive predicate `startedAt <= timestamp && timestamp <= completedAt`. An annotation or note qualifies when either `createdAt` or `updatedAt` is inside. A conversation qualifies only when it belongs to the same book and has at least one message inside. `hasReaderEvidence` stops after finding the first matching row in any of the three sources.

Add a focused export in `src/main/chat/messages.ts` only if it prevents duplicate `UIMessage.parts` text extraction; reuse `textOfParts()` from `@main/ai/prompt` rather than inventing another parser.

- [ ] **Step 4: Write target-scope and pagination tests for report tools**

In `src/main/reading-report/tools.test.ts`, invoke tool `execute` functions directly and assert:

- Current annotations/notes/conversations never include records outside the target session window.
- `getPreviousReadingReport` rejects the current session, a session from another book, and a report-less session.
- `readChapterText` and PDF `readPage` stay bound to the target book.
- List tools clamp `limit` to 100 and default to 50.
- A scanned PDF may still expose trace tools even when text mode returns an honest error.

- [ ] **Step 5: Implement the report-agent tool set**

Create `src/main/reading-report/tools.ts`:

```ts
export interface ReadingReportToolsDeps {
  db: DB;
  session: ReadingSessionRow;
  loadBytes: LoadBytes;
  imageToolResults: boolean;
}

export function createReadingReportTools(deps: ReadingReportToolsDeps) {
  const pageInput = z.object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(100).default(50),
  });
  const page = <T>(rows: T[], offset: number, limit: number) => ({
    items: rows.slice(offset, offset + limit),
    hasMore: offset + limit < rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  });
  return {
    ...createReadingTools({
      db: deps.db,
      bookId: deps.session.bookId,
      loadBytes: deps.loadBytes,
      imageToolResults: deps.imageToolResults,
    }),
    listAnnotations: tool({
      description: "List annotations created or updated during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listAnnotations", () =>
          page(listSessionAnnotations(deps.db, deps.session), offset, limit),
        ),
    }),
    listBookNotes: tool({
      description: "List book notes created or updated during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listBookNotes", () =>
          page(listSessionBookNotes(deps.db, deps.session), offset, limit),
        ),
    }),
    listConversations: tool({
      description: "List conversations with messages during this reading session.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listConversations", () =>
          page(listSessionConversations(deps.db, deps.session), offset, limit),
        ),
    }),
    readConversation: tool({
      description: "Read the in-session turns of one listed conversation with neighboring context.",
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) =>
        runTool("readConversation", () =>
          readSessionConversation(deps.db, deps.session, conversationId),
        ),
    }),
    listPreviousReadingSessions: tool({
      description: "List earlier completed readings of this book without report bodies.",
      inputSchema: pageInput,
      execute: async ({ offset, limit }) =>
        runTool("listPreviousReadingSessions", () => {
          const rows = listReadingSessionRows(deps.db, deps.session.bookId).filter(
            (row) =>
              row.id !== deps.session.id &&
              row.completedAt !== null &&
              row.completedAt <= deps.session.startedAt,
          );
          return page(
            rows.map((row) => toReadingSessionSummary(deps.db, row)),
            offset,
            limit,
          );
        }),
    }),
    getPreviousReadingReport: tool({
      description: "Read the saved report from one earlier listed reading session.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      execute: async ({ sessionId }) =>
        runTool("getPreviousReadingReport", () => {
          const row = getReadingSession(deps.db, sessionId);
          if (!row || row.bookId !== deps.session.bookId || row.id === deps.session.id) {
            throw new Error("previous reading session not found for this book");
          }
          const content = row.report?.trim();
          if (!content) throw new Error("previous reading session has no report");
          return { ...toReadingSessionSummary(deps.db, row), content };
        }),
    }),
    getSessionReadingStats: tool({
      description: "Get active reading seconds for the current reading session.",
      inputSchema: z.object({}),
      execute: async () =>
        runTool("getSessionReadingStats", () => ({
          activeSeconds: readingSessionSeconds(deps.db, deps.session.id),
        })),
    }),
  };
}
```

The target `bookId` and current `sessionId` must be closed over and absent from model-controlled arguments. Wrap every execution in the existing `runTool()` discipline so a recoverable tool failure becomes `{ error }` and the agent can self-correct.

- [ ] **Step 6: Run evidence and tool tests**

Run:

```bash
pnpm test src/main/reading-report/evidence.test.ts src/main/reading-report/tools.test.ts src/main/ai/tools.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the evidence slice**

```bash
git add src/main/reading-report src/main/chat/messages.ts
git commit -m "feat: add reading report evidence tools"
```

---

### Task 3: Implement the Report Agent, Runtime State, and Report IPC

**Files:**

- Create: `src/main/reading-report/agent.ts`
- Create: `src/main/reading-report/runtime.ts`
- Create: `src/main/reading-report/service.ts`
- Create: `src/main/reading-report/service.test.ts`
- Modify: `src/main/ai/send-deps.ts`
- Modify: `src/main/ipc/reading-sessions-handlers.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload-api.ts`

**Interfaces:**

- Consumes: summary-model resolution, background limiter, `createReadingReportTools()`, report repository functions, and report discriminated unions.
- Produces: `runReadingReportAgent()`, `ReadingReportRuntime`, `getReadingSessionDetail()`, `startReadingReportGeneration()`, and the remaining report IPC methods.

- [ ] **Step 1: Write service-state tests first**

Use an injected deferred `runAgent` promise so the test can inspect state while work is in flight. Cover all six branches:

```ts
expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "empty" });
expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "accepted" });
expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "generating" });

resolveAgent("# What stayed with me");
await drainBackground();
expect(getReadingSessionDetail(deps, session.id).report).toEqual({
  status: "ready",
  content: "# What stayed with me",
});
```

Also test initial failure, regeneration in flight with old content, regeneration failure preserving old content, duplicate start deduplication, application-restart semantics using a fresh runtime instance, zero evidence returning `insufficient-evidence` without calling the model, and user save clearing a prior failure.

- [ ] **Step 2: Run the service tests and verify failure**

Run:

```bash
pnpm test src/main/reading-report/service.test.ts
```

Expected: FAIL because the runtime and service modules do not exist.

- [ ] **Step 3: Implement the six-state runtime mapper**

Create `src/main/reading-report/runtime.ts` with one instance-owned map for in-flight kind and one for failure. Do not use module-global sets so tests and application restart semantics are explicit:

```ts
type GenerationKind = "initial" | "regeneration";
type Failure = { kind: GenerationKind; reason: string };

export class ReadingReportRuntime {
  readonly inFlight = new Map<string, GenerationKind>();
  readonly failures = new Map<string, Failure>();

  state(sessionId: string, storedReport: string | null): ReadingReportState;
  claim(sessionId: string, kind: GenerationKind): boolean;
  fail(sessionId: string, failure: Failure): void;
  succeed(sessionId: string): void;
  clearFailure(sessionId: string): void;
}
```

State precedence is `inFlight` → failure → non-empty stored report → empty. The failure branch uses stored content to choose `regeneration-failed`; an initial failure never includes content.

- [ ] **Step 4: Implement the bounded AI SDK agent loop**

Create `src/main/reading-report/agent.ts` with `READING_REPORT_SYSTEM` and:

```ts
export interface RunReadingReportAgentInput {
  resolved: Extract<ResolvedModel, { ok: true }>;
  tools: ReturnType<typeof createReadingReportTools>;
  bookTitle: string | null;
  startedAt: number;
  completedAt: number;
  activeSeconds: number;
}

export async function runReadingReportAgent(input: RunReadingReportAgentInput): Promise<string>;
```

Call `generateText()` with `tools`, `stopWhen: isStepCount(10)`, `maxOutputTokens: 4096`, `maxRetries: 1`, provider call options, and the resolved reasoning effort. The system prompt must require first-person editable Markdown, reader-trace grounding, omission of unsupported sections, and explicit cross-reading comparisons. Log each step at `debug` with only counts and finish reason; return trimmed text and throw on empty output.

- [ ] **Step 5: Implement generation orchestration and atomic persistence**

Create `src/main/reading-report/service.ts` with injected dependencies:

```ts
export interface ReadingReportServiceDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  runBackground: RunBackground;
  runAgent: typeof runReadingReportAgent;
  runtime: ReadingReportRuntime;
}

export function getReadingSessionDetail(
  deps: Pick<ReadingReportServiceDeps, "db" | "runtime">,
  sessionId: string,
): ReadingSessionDetailDto;

export function startReadingReportGeneration(
  deps: ReadingReportServiceDeps,
  sessionId: string,
): GenerateReadingReportResult;

export function saveUserReadingReport(
  deps: Pick<ReadingReportServiceDeps, "db" | "runtime">,
  sessionId: string,
  content: string,
): ReadingSessionDetailDto;
```

`startReadingReportGeneration` performs synchronous validation and evidence preflight, claims runtime state before launching work, then starts one `void deps.runBackground(...)` chain. Success updates `reading_sessions.report` once after the agent returns non-empty text. Catch logs `warn`, preserves old content, records a user-safe reason, and always releases in-flight state. It must never create conversations, messages, or memories.

The exact synchronous order is: load and validate a completed session, return `accepted` immediately for an existing in-flight claim, run `hasReaderEvidence`, resolve the summary model, then claim. A missing model records the correct initial/regeneration failure kind and throws its honest reason to IPC. The background body creates tools with `supportsImageToolResults(resolved.providerType)` and calls the injected agent. Because the promise and runtime live in main, closing the page does not cancel work; quitting the app ends it naturally, and a fresh runtime derives `empty` or `ready` from persisted Markdown on restart.

- [ ] **Step 6: Add production dependency wiring**

In `src/main/ai/send-deps.ts`, reuse the process-level `backgroundLimiter` and `createLoadBytes()`:

```ts
const readingReportRuntime = new ReadingReportRuntime();

export function makeReadingReportDeps(): ReadingReportServiceDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(appService.getPath("booksDir"), db),
    resolveModel: () => resolveSummaryModel(db),
    runBackground: backgroundLimiter.run,
    runAgent: runReadingReportAgent,
    runtime: readingReportRuntime,
  };
}
```

This is the only production runtime instance. Do not fall back through `resolveChatModel()`.

- [ ] **Step 7: Add detail, generate, and save IPC**

Add contracts:

```ts
readingSessionsGet: def(
  "reading-sessions:get",
  "invoke",
  readingSessionIdInput,
  out<ReadingSessionDetailDto>(),
),
readingSessionsGenerateReport: def(
  "reading-sessions:generate-report",
  "invoke",
  readingSessionIdInput,
  out<GenerateReadingReportResult>(),
),
readingSessionsSaveReport: def(
  "reading-sessions:save-report",
  "invoke",
  saveReadingReportInput,
  out<ReadingSessionDetailDto>(),
),
```

Bind them in `reading-sessions-handlers.ts` using `makeReadingReportDeps()`. Expose `get`, `generateReport`, and `saveReport` under `window.api.readingSessions`.

- [ ] **Step 8: Run report service and IPC verification**

Run:

```bash
pnpm test src/main/reading-report/service.test.ts src/main/ipc/bindings-coverage.test.ts src/preload-api.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit the report engine**

```bash
git add src/main/reading-report src/main/ai/send-deps.ts src/main/ipc/reading-sessions-handlers.ts src/shared/ipc.ts src/preload-api.ts
git commit -m "feat: generate reading completion reports"
```

---

### Task 4: Let Normal Chat AI Read Session Reports

**Files:**

- Create: `src/main/ai/reading-session-tools.ts`
- Create: `src/main/ai/reading-session-tools.test.ts`
- Modify: `src/main/ai/context-tools.ts`
- Modify: `src/main/ai/context-tools.test.ts`
- Modify: `src/main/ai/library-tools.ts`
- Modify: `src/main/ai/library-tools.test.ts`

**Interfaces:**

- Consumes: session repository functions and context tool composition.
- Produces: AI tools named exactly `listReadingSessions` and `getReadingReport` in reader and library contexts.

- [ ] **Step 1: Write reader/library scope tests**

Assert the following direct tool calls:

```ts
const readerTools = createReadingSessionTools({ db, scopedBookId: "book-a" });
await expect(readerTools.listReadingSessions.execute!({})).resolves.toEqual([
  expect.objectContaining({ bookId: "book-a", reportAvailable: true }),
]);
await expect(
  readerTools.getReadingReport.execute!({ sessionId: sessionFromBookB.id }),
).resolves.toEqual(expect.objectContaining({ error: expect.stringMatching(/current book/) }));

const libraryTools = createReadingSessionTools({ db, scopedBookId: null });
await expect(libraryTools.listReadingSessions.execute!({ bookId: "book-b" })).resolves.toHaveLength(
  1,
);
```

The list result must not contain report Markdown. `getReadingReport` must return metadata plus current saved Markdown and reject active/report-less sessions with an honest tool error.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
pnpm test src/main/ai/reading-session-tools.test.ts src/main/ai/context-tools.test.ts
```

Expected: FAIL because the new tools are absent.

- [ ] **Step 3: Implement and compose the tools**

Create:

```ts
export function createReadingSessionTools({
  db,
  scopedBookId,
}: {
  db: DB;
  scopedBookId: string | null;
}) {
  return {
    listReadingSessions: tool({
      description:
        "List reading sessions for the current or requested library book without report bodies.",
      inputSchema: z.object({ bookId: z.string().min(1).optional() }),
      execute: async ({ bookId }) =>
        runTool("listReadingSessions", () => {
          const target = scopedBookId ?? bookId;
          if (!target) throw new Error("bookId is required in library context");
          if (scopedBookId && bookId && bookId !== scopedBookId) {
            throw new Error("cannot list sessions outside the current book");
          }
          return listReadingSessions(db, target);
        }),
    }),
    getReadingReport: tool({
      description: "Read one saved completion report by session id after listing sessions.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      execute: async ({ sessionId }) =>
        runTool("getReadingReport", () => {
          const session = getReadingSession(db, sessionId);
          const content = session?.report?.trim();
          if (!session || session.completedAt == null || !content) {
            throw new Error("completed reading session with a report not found");
          }
          if (scopedBookId && session.bookId !== scopedBookId) {
            throw new Error("session does not belong to the current book");
          }
          return { ...toReadingSessionSummary(db, session), content };
        }),
    }),
  };
}
```

Merge these tools in `createContextTools()` for both contexts. Update existing library tool descriptions and outputs from `isFinished` to `readingState` only after Task 5 performs the state cutover; at this task, do not change the legacy field yet.

- [ ] **Step 4: Run AI tool tests**

Run:

```bash
pnpm test src/main/ai/reading-session-tools.test.ts src/main/ai/context-tools.test.ts src/main/ai/library-tools.test.ts
```

Expected: PASS and context tool names include both new tools in reader and library modes.

- [ ] **Step 5: Commit the normal-AI tools**

```bash
git add src/main/ai/reading-session-tools.ts src/main/ai/reading-session-tools.test.ts src/main/ai/context-tools.ts src/main/ai/context-tools.test.ts src/main/ai/library-tools.ts src/main/ai/library-tools.test.ts
git commit -m "feat: let chat read completion reports"
```

---

### Task 5: Cut Over Book State, Reading Time, and Book Routing

**Files:**

- Create: `src/main/db/migrate-reading-sessions.test.ts`
- Create: `src/renderer/reading/route-state.ts`
- Create: `src/renderer/reading/route-state.test.ts`
- Create: `src/renderer/reading/BookRoute.tsx`
- Create: `src/renderer/reading/ReadingStartView.tsx`
- Create: `src/renderer/reading/CompleteReadingDialog.tsx`
- Create: `src/renderer/reading/ReadingReportView.tsx`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/stats/reading-daily.ts`
- Modify: `src/main/stats/reading-daily.test.ts`
- Modify: `src/main/stats/clock-wiring.ts`
- Modify: `src/main/library/repository.ts`
- Modify: `src/main/library/repository.test.ts`
- Modify: `src/main/library/progress.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/main/ipc/stats-handlers.ts`
- Modify: `src/shared/library.ts`
- Modify: `src/shared/library.test.ts`
- Modify: `src/shared/stats.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload-api.ts`
- Modify: `src/main/ai/library-tools.ts`
- Modify: `src/main/ai/library-tools.test.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/store/navigation-store.ts`
- Modify: `src/renderer/store/navigation-store.test.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`
- Modify: `src/renderer/reader/EpubReader.tsx`
- Modify: `src/renderer/reader/PdfReader.tsx`
- Modify: `src/renderer/reader/use-reading-clock.ts`
- Modify: `src/renderer/library/LibraryView.tsx`
- Modify: `src/renderer/library/BookCover.tsx`
- Modify: `src/renderer/library/SortableBook.tsx`
- Modify: `src/renderer/library/CoverImage.tsx`
- Modify: `src/renderer/query/keys.ts`
- Generated: `src/main/db/migrations/*_derive_reading_state/migration.sql`
- Generated: `src/main/db/migrations/*_derive_reading_state/snapshot.json`

**Interfaces:**

- Consumes: lifecycle IPC and `getActiveReadingSession()`.
- Produces: derived `BookSummaryDto.readingState`, session-aware `addSeconds()`, route modes `auto/reference`, start page, active reader, and reference reader.

- [ ] **Step 1: Write same-day session timing tests**

Replace old `addSeconds` test calls with the new signature and add:

```ts
addSeconds(db, {
  bookId: "b1",
  readingSessionId: first.id,
  day: "2026-07-14",
  seconds: 30,
});
addSeconds(db, {
  bookId: "b1",
  readingSessionId: second.id,
  day: "2026-07-14",
  seconds: 45,
});
expect(readingSessionSeconds(db, first.id)).toBe(30);
expect(readingSessionSeconds(db, second.id)).toBe(45);
expect(dailyTotals(db)).toEqual([{ day: "2026-07-14", seconds: 75 }]);
expect(perBookTotals(db)[0]?.seconds).toBe(75);
```

Also test that deleting a session sets `reading_session_id` to null while totals remain, and deleting a book nulls both FKs while global daily totals remain.

- [ ] **Step 2: Write route resolver tests**

Create `route-state.ts` with this interface and test every branch:

```ts
export type BookDestination = "start" | "reader-active" | "reader-reference" | "report";

export function resolveBookDestination(
  readingState: BookReadingState,
  mode: "auto" | "reference",
): BookDestination;
```

Expected table:

| Reading state | Mode        | Destination        |
| ------------- | ----------- | ------------------ |
| `not-started` | `auto`      | `start`            |
| `reading`     | `auto`      | `reader-active`    |
| `finished`    | `auto`      | `report`           |
| `finished`    | `reference` | `reader-reference` |
| `reading`     | `reference` | `reader-active`    |
| `not-started` | `reference` | `start`            |

- [ ] **Step 3: Run timing and route tests and verify failure**

Run:

```bash
pnpm test src/main/stats/reading-daily.test.ts src/renderer/reading/route-state.test.ts
```

Expected: FAIL because the time signature and route resolver have not changed.

- [ ] **Step 4: Make `reading_daily` session-aware and remove `books.isFinished`**

In `schema.ts`:

- Remove `books.isFinished`.
- Remove `reading_daily_book_day_unique`.
- Add:

```ts
uniqueIndex("reading_daily_session_day_unique")
  .on(t.readingSessionId, t.day)
  .where(sql`${t.readingSessionId} is not null`),
index("reading_daily_session_id_idx").on(t.readingSessionId),
```

Run:

```bash
pnpm db:generate --name derive_reading_state
```

Expected: generated migrations rebuild affected SQLite tables and remove `is_finished`; the protected application data-migration staging step then creates one real legacy session for each book with traces and backfills every legacy `reading_daily` row for that book to the session. Do not edit generated files.

- [ ] **Step 5: Update reading-time writes and aggregation**

Change `addSeconds` to:

```ts
export interface AddReadingSecondsInput {
  bookId: string;
  readingSessionId: string;
  day: string;
  seconds: number;
}

export function addSeconds(db: DB, input: AddReadingSecondsInput): void;
```

Use this exact partial-index conflict target and never upsert a null session ID:

```ts
.onConflictDoUpdate({
  target: [readingDaily.readingSessionId, readingDaily.day],
  targetWhere: sql`${readingDaily.readingSessionId} is not null`,
  set: { seconds: sql`${readingDaily.seconds} + ${input.seconds}` },
})
```

In `clock-wiring.ts`, keep the pure clock's book-only state, but resolve the current active session immediately before each commit:

```ts
const session = getActiveReadingSession(db, bookId);
if (!session) {
  log.warn(`dropping reading time without active session for book ${bookId}`);
  return;
}
addSeconds(db, {
  bookId,
  readingSessionId: session.id,
  day: localDayKey(atMs),
  seconds,
});
```

The completion handler must continue calling `setReadingBook(null)` before closing the session.

- [ ] **Step 6: Derive library book state and remove the legacy toggle**

Change `BookSummaryDto` to contain:

```ts
readingState: BookReadingState;
```

Remove `setBookFinishedInput`, `C.librarySetFinished`, `setBookFinished()`, its IPC binding, preload method, LibraryView mutation, and BookCover context-menu action. Update `listBooks()` to derive state from all sessions and `listRecentlyRead()` to include only books with an active session. Update `library-tools.ts` descriptions and outputs to expose `readingState` instead of `isFinished`.

In `CoverImage.tsx`, render the existing check badge only when `book.readingState === "finished"` and use a translated tooltip. The reading state itself remains derived; no renderer write toggles it.

- [ ] **Step 7: Gate clock and progress writes on an active session**

Change `statsReadingStateInput` to a discriminated union:

```ts
export const statsReadingStateInput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.literal("active"), bookId: z.string().min(1) }),
]);
```

The stats handler verifies an active session before setting the clock to a book. The progress-save handler likewise rejects writes without an active session. Reference mode reports `idle` and renderer guards prevent save attempts.

- [ ] **Step 8: Add navigation route mode and the book router**

Change navigation state to:

```ts
interface NavigationState {
  view: "library" | "stats" | "book";
  currentBookId: string | null;
  bookMode: "auto" | "reference";
  // existing chapter/context/percent fields remain
}
```

`openBook(bookId)` sets `view: "book", bookMode: "auto"`; add `openBookReference(bookId)` that sets `bookMode: "reference"`. Update navigation tests and all expectations that previously used `view: "reader"`.

Create `BookRoute.tsx` to query `qk.book(bookId)`, call `resolveBookDestination`, and render `ReadingStartView`, `<ReaderView mode="active" />`, `<ReaderView mode="reference" />`, or `ReadingReportView`. Loading, missing-book, and query-error states must be explicit.

In this task, `ReadingReportView` is a complete lightweight completion landing surface: show the book header, “Reading complete” state, back-to-library action, and “Open text for reference” action. Task 6 expands the same component with report generation, editing, session history, and reread; do not create a second completion component.

- [ ] **Step 9: Implement the start ritual**

`ReadingStartView` shows the cover, title, author, and one primary action. On click:

```ts
await window.api.readingSessions.start({ mode: "continue", bookId });
await Promise.all([
  qc.invalidateQueries({ queryKey: qk.book(bookId) }),
  qc.invalidateQueries({ queryKey: qk.library }),
  qc.invalidateQueries({ queryKey: qk.recentlyRead }),
]);
```

Do not clear `qk.progress(bookId)` for `continue`; migrated readers resume their old location.

- [ ] **Step 10: Add active/reference reader behavior and completion**

Change `ReaderView` to accept `mode: "active" | "reference"`. Pass `persistProgress={mode === "active"}` into both reader engines and call `useReadingClock(mode === "active" ? bookId : null)`.

In `EpubReader` and `PdfReader`, continue reading the saved locator in both modes, but skip every debounce timer, `progress.save`, and query-cache progress write when `persistProgress` is false.

Create `CompleteReadingDialog` in the active reader header. Confirming calls `readingSessions.complete`, invalidates book/library/recent/session queries, and lets `BookRoute` move to the report destination. Reference mode replaces the completion button with a small “Reference mode” label.

- [ ] **Step 11: Add the migration preservation test**

Create `migrate-reading-sessions.test.ts`. Copy migration directories only through `20260616082526_luxuriant_centennial` into a temporary folder, migrate a disk-backed temporary DB to that legacy point, seed raw SQL rows for:

- one `is_finished = true` book,
- progress,
- annotation,
- book note,
- conversation and message,
- one `reading_daily` row.

Then close and reopen the DB, run the full current migrations directory, and assert:

```ts
expect(db.get(sql`select * from reading_sessions where book_id = 'legacy-book'`)).toBeDefined();
expect(db.get(sql`select locator from progress where book_id = 'legacy-book'`)).toBeDefined();
expect(
  db.get(sql`select selected_text from annotations where book_id = 'legacy-book'`),
).toBeDefined();
expect(
  db.get(sql`select reading_session_id from reading_daily where book_id = 'legacy-book'`),
).toMatchObject({ reading_session_id: expect.any(String) });
expect(db.all<{ name: string }>(sql`pragma table_info(books)`).map((c) => c.name)).not.toContain(
  "is_finished",
);
```

Add three fault-injection recovery cases against the same disk-backed fixture: throw after staging commits but before DDL, after DDL commits but before post-apply, and inside post-apply immediately after session insertion. Each case closes/reopens the database, runs the normal migration path, and proves exactly one session has the correct start/completion timestamps, every legacy daily row points to that session, staging is removed, and a second run creates no duplicate.

- [ ] **Step 12: Run the vertical-cutover verification**

Run:

```bash
pnpm test src/main/stats/reading-daily.test.ts src/main/library/repository.test.ts src/main/db/migrate-reading-sessions.test.ts src/renderer/reading/route-state.test.ts src/renderer/store/navigation-store.test.ts src/main/ai/library-tools.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 13: Commit the state and routing cutover**

```bash
git add src/main/db src/main/stats src/main/library src/main/ipc src/main/ai/library-tools.ts src/main/ai/library-tools.test.ts src/shared src/preload-api.ts src/renderer/App.tsx src/renderer/store/navigation-store.ts src/renderer/store/navigation-store.test.ts src/renderer/reader src/renderer/library src/renderer/reading src/renderer/query/keys.ts
git commit -m "feat: route books through reading sessions"
```

---

### Task 6: Build the Completion Report Page and Reread Flow

**Files:**

- Create: `src/renderer/query/reading-session-queries.ts`
- Create: `src/renderer/reading/report-view-model.ts`
- Create: `src/renderer/reading/report-view-model.test.ts`
- Create: `src/renderer/reading/ReportEditor.tsx`
- Modify: `src/renderer/reading/ReadingReportView.tsx`
- Modify: `src/renderer/reading/BookRoute.tsx`
- Modify: `src/renderer/query/keys.ts`
- Modify: `src/renderer/stats/format-duration.ts`

**Interfaces:**

- Consumes: all reading-session IPC methods, `MarkdownEditor`, `LocalizedStreamdown`, and navigation reference mode.
- Produces: layout A report page, session history, generate/regenerate/edit/save, reference mode, and reread.

- [ ] **Step 1: Write exhaustive report view-model tests**

Create a projection that forces an exhaustive switch:

```ts
export interface ReportViewModel {
  content: string | null;
  busy: boolean;
  canGenerate: boolean;
  canEdit: boolean;
  error: string | null;
}

export function reportViewModel(state: ReadingReportState): ReportViewModel;
```

Test all six statuses. `regenerating` keeps old content but locks editing; `regeneration-failed` keeps old content and enables retry/edit; `generation-failed` has no content; `ready` enables edit/regenerate.

- [ ] **Step 2: Run the view-model test and verify failure**

Run:

```bash
pnpm test src/renderer/reading/report-view-model.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement session query options and polling**

Add query keys:

```ts
readingSessions: (bookId: string) => ["reading-sessions", bookId] as const,
readingSession: (sessionId: string) => ["reading-session", sessionId] as const,
```

Create query options where session detail uses:

```ts
refetchInterval: (query) => {
  const status = query.state.data?.report.status;
  return status === "generating" || status === "regenerating" ? 400 : false;
},
```

The list query orders newest session first in the main-process repository; renderer does not re-sort timestamps independently.

- [ ] **Step 4: Implement the report state projection and editor**

Implement `reportViewModel` with a `default` branch that calls `assertNever(state)`. Create `ReportEditor.tsx` by reusing `MarkdownEditor`; it receives `initialContent`, `disabled`, `onSave`, and `onCancel`, trims before save, and disables save for empty content.

- [ ] **Step 5: Build layout A in `ReadingReportView.tsx`**

The page contains:

- top navigation back to library,
- cover/title/author header,
- session selector defaulting to the newest completed session,
- start date, completed date, elapsed calendar days, and active duration,
- Markdown preview using `LocalizedStreamdown`,
- generate/retry/regenerate buttons derived from `ReportViewModel`,
- explicit edit/save/cancel mode,
- “Open text for reference” and “Read again” actions.

Use `Intl.DateTimeFormat.format(epochMilliseconds)` for date labels. For elapsed days, convert both instants to local `Temporal.PlainDate` and use `start.until(end).days + 1`; do not construct `Date`.

- [ ] **Step 6: Wire generation and manual editing**

Generation mutation behavior:

```ts
const result = await window.api.readingSessions.generateReport({ sessionId });
if (result.outcome === "insufficient-evidence") {
  setEditing(true);
  toast.info(t("readingReport.insufficientEvidence", "还没有足够的阅读痕迹，可以先手写这份报告。"));
}
await qc.invalidateQueries({ queryKey: qk.readingSession(sessionId) });
```

Save calls `saveReport`, updates the detail cache with its returned DTO, and exits edit mode only on success. Errors use persistent honest-error toasts. While regenerating, old Markdown stays visible and the editor is disabled.

- [ ] **Step 7: Wire reference and reread actions**

Reference calls `openBookReference(bookId)` without any IPC write.

Reread requires confirmation, then:

```ts
await window.api.readingSessions.start({ mode: "restart", bookId });
qc.removeQueries({ queryKey: qk.progress(bookId) });
await Promise.all([
  qc.invalidateQueries({ queryKey: qk.book(bookId) }),
  qc.invalidateQueries({ queryKey: qk.library }),
  qc.invalidateQueries({ queryKey: qk.recentlyRead }),
  qc.invalidateQueries({ queryKey: qk.readingSessions(bookId) }),
]);
openBook(bookId);
```

Keep `BookRoute` pointed at the now-expanded `ReadingReportView`.

- [ ] **Step 8: Run renderer tests and typecheck**

Run:

```bash
pnpm test src/renderer/reading/report-view-model.test.ts src/renderer/reading/route-state.test.ts src/renderer/store/navigation-store.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit the completion page**

```bash
git add src/renderer/reading src/renderer/query src/renderer/stats/format-duration.ts
git commit -m "feat: add reading completion report page"
```

---

### Task 7: Localize, Verify, and Prepare the User-Facing Change

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`
- Modify: `src/shared/i18n/locales/en.ts`
- Create: `.changeset/reading-completion-reports.md`
- Modify as required by formatting only: files touched in Tasks 1–6

**Interfaces:**

- Consumes: complete vertical feature.
- Produces: synchronized translations, release note, full automated verification, and manual acceptance evidence.

- [ ] **Step 1: Extract translation keys**

Run:

```bash
pnpm i18n:extract
```

Expected: new `readingStart.*`, `readingSession.*`, `readingReport.*`, `reader.completeReading.*`, and updated library-state keys appear in both locale files.

- [ ] **Step 2: Fill English translations and remove obsolete finished-toggle keys**

Use these English meanings consistently:

| Key family                            | English copy                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `readingStart.title`                  | `Begin this reading`                                                                 |
| `readingStart.description`            | `Mark the beginning so Marginalia can keep this reading's time and traces together.` |
| `readingStart.action`                 | `Start reading`                                                                      |
| `reader.completeReading.action`       | `Complete reading`                                                                   |
| `reader.completeReading.confirmTitle` | `Complete this reading?`                                                             |
| `readingReport.title`                 | `Reading report`                                                                     |
| `readingReport.generate`              | `Generate report`                                                                    |
| `readingReport.regenerate`            | `Regenerate`                                                                         |
| `readingReport.edit`                  | `Edit Markdown`                                                                      |
| `readingReport.reference`             | `Open text for reference`                                                            |
| `readingReport.reread`                | `Read again`                                                                         |
| `readingReport.insufficientEvidence`  | `There are not enough reading traces yet. You can write this report yourself.`       |
| `readingSession.startedAt`            | `Started`                                                                            |
| `readingSession.completedAt`          | `Completed`                                                                          |
| `readingSession.elapsedDays`          | `Elapsed days`                                                                       |
| `readingSession.activeTime`           | `Active reading time`                                                                |

Remove locale entries for `library.menu.markFinished`, `library.menu.unmarkFinished`, and their mutation error after source references are gone. Keep the finished badge label, now driven by derived state.

- [ ] **Step 3: Add a changeset**

Create `.changeset/reading-completion-reports.md`:

```markdown
---
"marginalia": minor
---

Add explicit reading sessions with session-aware reading time and editable AI-generated completion reports grounded in the reader's annotations, notes, and conversations.
```

- [ ] **Step 4: Run focused feature tests**

Run:

```bash
pnpm test src/main/reading-sessions/repository.test.ts src/main/reading-report/evidence.test.ts src/main/reading-report/tools.test.ts src/main/reading-report/service.test.ts src/main/ai/reading-session-tools.test.ts src/main/stats/reading-daily.test.ts src/main/db/migrate-reading-sessions.test.ts src/renderer/reading/route-state.test.ts src/renderer/reading/report-view-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full quality gate**

Run each command separately and fix any failure before continuing:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm i18n:lint
```

Expected: every command exits 0.

- [ ] **Step 6: Perform the manual Electron acceptance path**

Run:

```bash
pnpm start
```

Verify in the app:

1. A legacy-progress book opens the start page and “Start reading” resumes its saved location.
2. Active reading writes time and permits progress writes.
3. Completing flushes the clock, opens the report page, and keeps completion if model generation fails.
4. A traced session generates a reader-centered report; zero-trace generation offers the blank editor without a model call.
5. Editing and saving immediately changes what normal chat receives from `getReadingReport`.
6. Reference mode reads the saved location but changes neither progress nor time.
7. “Read again” clears progress, creates a new active session, and starts from the beginning.
8. Two sessions on the same local day retain separate session durations while global and per-book totals equal their sum.
9. The second report can read the first report when the agent chooses to compare them.

- [ ] **Step 7: Commit localization and release note**

```bash
git add src/shared/i18n/locales .changeset/reading-completion-reports.md
git commit -m "chore: document reading completion reports"
```

- [ ] **Step 8: Update the kanban only after the implementation is integrated**

Use the repository `kanban` skill to update Issue #78 with the design and implementation-plan links. Move it to Done and close it only when the implementation branch is merged or otherwise integrated into the project truth source.

---

## Incremental Plan: Assistant Voice, Durable Memory, and Bounded Conversations

Tasks 1–7 above are already implemented on `codex/reading-completion-reports`. The following tasks implement the approved 2026-07-14 design refinement without changing the database schema, shared IPC contracts, or renderer UI.

### Task 8: Compose a Live Report-Specific Assistant Prompt

**Files:**

- Create: `src/main/reading-report/prompt.ts`
- Create: `src/main/reading-report/prompt.test.ts`
- Modify: `src/main/ai/agent-context.ts`
- Modify: `src/main/ai/agent-context.test.ts`
- Modify: `src/main/reading-report/agent.ts`
- Modify: `src/main/reading-report/service.ts`
- Modify: `src/main/reading-report/service.test.ts`

**Interfaces:**

- Produces: `renderReaderInstructions(db)`, `renderAssistantIdentity(db)`, `renderMemoryIndex(db)`, `buildReadingReportSystemPrompt(db)`, and `RunReadingReportAgentInput.instructions`.
- Preserves: `renderAgentContext(db)` output order and `getAgentContext(db, conversationId)` snapshot behavior for normal chat.
- Consumes: `getPreference()`, `listMemories()`, `DEFAULT_SOUL`, and the existing report service lifecycle.

- [ ] **Step 1: Write failing prompt-composition tests**

Create `src/main/reading-report/prompt.test.ts` with a migrated in-memory DB and these assertions:

```ts
it("writes as the configured assistant and places reader instructions last", () => {
  setPreference(db, "soul", { name: "Mia", persona: "Warm, precise, and curious." });
  setPreference(db, "instructions", "Use short titled sections.");
  createMemory(db, {
    slug: "systems-thinking",
    title: "Systems thinking",
    description: "The reader connects mechanisms across books.",
    body: "Stable context.",
  });

  const prompt = buildReadingReportSystemPrompt(db);

  expect(prompt).toContain("from your own first-person perspective as the assistant");
  expect(prompt).toContain("Your name is Mia. Warm, precise, and curious.");
  expect(prompt).toContain("[systems-thinking] Systems thinking");
  expect(prompt).toContain("Use short titled sections.");
  expect(prompt.indexOf("Use short titled sections.")).toBeGreaterThan(
    prompt.indexOf("from your own first-person perspective as the assistant"),
  );
  expect(prompt).not.toContain("in the reader's first person");
});

it("omits memory guidance and index when memory is disabled", () => {
  setPreference(db, "memoryEnabled", false);
  createMemory(db, {
    slug: "hidden",
    title: "Hidden",
    description: "Must not be injected.",
    body: "Hidden body.",
  });

  const prompt = buildReadingReportSystemPrompt(db);

  expect(prompt).not.toContain("## Memory index");
  expect(prompt).not.toContain("saveMemory");
  expect(prompt).not.toContain("[hidden]");
  expect(prompt).toContain("## Who you are");
});
```

Extend `src/main/ai/agent-context.test.ts` to assert that the new composable renderers reproduce the existing chat context byte-for-byte:

```ts
expect(renderAgentContext(db)).toBe(
  [renderReaderInstructions(db), renderAssistantIdentity(db), renderMemoryIndex(db)]
    .filter((section): section is string => section !== null)
    .join("\n\n"),
);
```

- [ ] **Step 2: Run the prompt tests and verify RED**

Run:

```bash
pnpm test src/main/reading-report/prompt.test.ts src/main/ai/agent-context.test.ts
```

Expected: FAIL because `@main/reading-report/prompt` and the three composable context renderers do not exist.

- [ ] **Step 3: Extract composable live context renderers without changing chat snapshots**

In `src/main/ai/agent-context.ts`, extract these exact functions and rebuild `renderAgentContext` from them:

```ts
export function renderReaderInstructions(db: DB): string | null {
  const instructions = getPreference(db, "instructions")?.trim();
  return instructions ? `## Reader instructions\n\n${instructions}` : null;
}

export function renderAssistantIdentity(db: DB): string {
  const soul = getPreference(db, "soul") ?? DEFAULT_SOUL;
  return `## Who you are\n\nYour name is ${soul.name}. ${soul.persona}`.trimEnd();
}

export function renderMemoryIndex(db: DB): string | null {
  if (!(getPreference(db, "memoryEnabled") ?? true)) return null;
  const all = listMemories(db);
  if (all.length === 0) return null;
  return `## Memory index\n\n${all
    .map((memory) => `- [${memory.slug}] ${memory.title} — ${memory.description}`)
    .join("\n")}`;
}

export function renderAgentContext(db: DB): string {
  return [renderReaderInstructions(db), renderAssistantIdentity(db), renderMemoryIndex(db)]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}
```

Do not change `getAgentContext`, invalidation, or snapshot keys.

- [ ] **Step 4: Implement the report-specific prompt composer**

Create `src/main/reading-report/prompt.ts` with a fixed core, optional memory guidance, live identity/index, and reader instructions last:

```ts
import type { DB } from "@main/db/client";
import {
  renderAssistantIdentity,
  renderMemoryIndex,
  renderReaderInstructions,
} from "@main/ai/agent-context";
import { getPreference } from "@main/preferences/repository";

export const READING_REPORT_CORE = `You write an editable Markdown completion report from your own first-person perspective as the assistant, addressing the reader as "you". Focus on the reader's questions, judgments, changes, connections, and what they want to retain. Ground every claim about the reader in traces available through tools; omit unsupported sections instead of inventing completeness. Do not turn the report into a book summary. You may compare a previous reading report only when you clearly label it as a cross-reading change rather than evidence from this reading. Long-term memory may explain or connect current traces only when clearly identified as your prior understanding of the reader, never as a direct observation from this reading. Evidence, target-session scope, and tool permissions cannot be overridden.`;

const REPORT_MEMORY_GUIDANCE = `## Memory guidance for this report

Use readMemory when an indexed memory may clarify the reader's durable viewpoint. Use saveMemory only for a new lasting preference, viewpoint, recurring concept, framework, correction, or cross-book connection. Use updateMemory instead of creating a near-duplicate. Never store book content, the complete report, or a one-off thought. Memory content follows the reader's language; slugs use English kebab-case.`;

export function buildReadingReportSystemPrompt(db: DB): string {
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  const readerInstructions = renderReaderInstructions(db);
  const prioritizedInstructions = readerInstructions
    ? `${readerInstructions}\n\nThese are the highest-priority report-writing preferences and may override the default perspective, structure, or content guidance above. They cannot override evidence, target-session scope, or tool permissions.`
    : null;
  return [
    READING_REPORT_CORE,
    renderAssistantIdentity(db),
    renderMemoryIndex(db),
    memoryEnabled ? REPORT_MEMORY_GUIDANCE : null,
    prioritizedInstructions,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}
```

- [ ] **Step 5: Pass a freshly built prompt into every agent run**

Change `RunReadingReportAgentInput` in `src/main/reading-report/agent.ts` to include `instructions: string`, delete the old `READING_REPORT_SYSTEM`, and pass `input.instructions` to `generateText`.

In the background callback in `src/main/reading-report/service.ts`, call `buildReadingReportSystemPrompt(deps.db)` immediately before `deps.runAgent(...)` and pass the resulting string. This call must happen for initial generation and every regeneration; do not cache it in `ReadingReportRuntime`.

Add a service test that starts two generations with changed preferences between them and captures the two `instructions` values:

```ts
const prompts: string[] = [];
deps.runAgent = vi.fn(async (input) => {
  prompts.push(input.instructions);
  return prompts.length === 1 ? "# First" : "# Second";
});
deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });

startReadingReportGeneration(deps, session.id);
await drain();
expect(prompts[0]).toContain("Your name is Lia");

setPreference(deps.db, "soul", { name: "Mia", persona: "New voice." });
setPreference(deps.db, "instructions", "Use bullets.");
startReadingReportGeneration(deps, session.id);
await drain();

expect(prompts[1]).toContain("Your name is Mia. New voice.");
expect(prompts[1]).toContain("Use bullets.");
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm test src/main/reading-report/prompt.test.ts src/main/ai/agent-context.test.ts src/main/reading-report/service.test.ts
pnpm typecheck
```

Expected: PASS, and normal chat snapshot tests remain unchanged.

- [ ] **Step 7: Commit the live prompt slice**

```bash
git add src/main/ai/agent-context.ts src/main/ai/agent-context.test.ts src/main/reading-report/agent.ts src/main/reading-report/prompt.ts src/main/reading-report/prompt.test.ts src/main/reading-report/service.ts src/main/reading-report/service.test.ts
git commit -m "feat: personalize reading completion reports"
```

---

### Task 9: Stage Report Memory Tools and Commit Them Atomically

**Files:**

- Create: `src/main/reading-report/memory-workspace.ts`
- Create: `src/main/reading-report/memory-workspace.test.ts`
- Modify: `src/main/db/client.ts`
- Modify: `src/main/memory/repository.ts`
- Modify: `src/main/memory/repository.test.ts`
- Modify: `src/main/reading-sessions/repository.ts`
- Modify: `src/main/reading-sessions/repository.test.ts`
- Modify: `src/main/reading-report/agent.ts`
- Modify: `src/main/reading-report/service.ts`
- Modify: `src/main/reading-report/service.test.ts`
- Modify: `src/main/ai/send-deps.ts`

**Interfaces:**

- Produces: `DBTransaction`, `ReadingReportMemoryMutation`, `createReadingReportMemoryWorkspace(db)`, `applyReadingReportMemoryMutations(tx, mutations, committedAt)`, and `saveReadingReportInTransaction(tx, sessionId, content)`.
- `createReadingReportMemoryWorkspace(db)` returns `{ tools, mutations }`; `mutations()` returns a fresh deterministic array reflecting the final staged overlay.
- The service composes evidence tools and memory tools for the agent, then commits final Markdown plus `mutations()` in one `db.transaction` after the generation token is revalidated.

- [ ] **Step 1: Write failing memory-workspace tests**

Create `src/main/reading-report/memory-workspace.test.ts`. Use real AI tool `execute` functions and cover these behaviors:

```ts
it("exposes only read, save, and update tools when memory is enabled", () => {
  const workspace = createReadingReportMemoryWorkspace(db);
  expect(Object.keys(workspace.tools).sort()).toEqual(["readMemory", "saveMemory", "updateMemory"]);
});

it("stages saves and lets later reads observe the overlay without touching the database", async () => {
  const workspace = createReadingReportMemoryWorkspace(db);
  await workspace.tools.saveMemory!.execute!(
    {
      slug: "attention-pattern",
      title: "Attention pattern",
      description: "The reader follows changes in attention.",
      body: "Connected to [[systems-thinking]].",
    },
    toolOptions,
  );
  const read = await workspace.tools.readMemory!.execute!(
    { slug: "attention-pattern" },
    toolOptions,
  );
  expect(read).toEqual(expect.objectContaining({ found: true, body: expect.any(String) }));
  expect(getMemoryBySlug(db, "attention-pattern")).toBeNull();
  expect(workspace.mutations()).toEqual([
    expect.objectContaining({ kind: "create", slug: "attention-pattern" }),
  ]);
});

it("collapses repeated updates into one optimistic mutation", async () => {
  const existing = createMemory(db, {
    slug: "systems-thinking",
    title: "Systems thinking",
    description: "Old description.",
    body: "Old body.",
  });
  const workspace = createReadingReportMemoryWorkspace(db);
  await workspace.tools.updateMemory!.execute!(
    { slug: existing.slug, description: "New description." },
    toolOptions,
  );
  await workspace.tools.updateMemory!.execute!(
    { slug: existing.slug, body: "New body." },
    toolOptions,
  );
  expect(workspace.mutations()).toEqual([
    expect.objectContaining({
      kind: "update",
      id: existing.id,
      expectedUpdatedAt: existing.updatedAt,
      description: "New description.",
      body: "New body.",
    }),
  ]);
});

it("returns no tools or mutations when memory is disabled", () => {
  setPreference(db, "memoryEnabled", false);
  const workspace = createReadingReportMemoryWorkspace(db);
  expect(workspace.tools).toEqual({});
  expect(workspace.mutations()).toEqual([]);
});
```

Also assert that overlay `readMemory` reports outgoing, incoming, and dangling links from the staged map rather than stale `memory_links` rows.

- [ ] **Step 2: Run the workspace test and verify RED**

Run:

```bash
pnpm test src/main/reading-report/memory-workspace.test.ts
```

Expected: FAIL because `@main/reading-report/memory-workspace` does not exist.

- [ ] **Step 3: Implement the in-memory overlay and report-scoped tools**

Create `src/main/reading-report/memory-workspace.ts` with this discriminated mutation type:

```ts
export type ReadingReportMemoryMutation =
  | {
      kind: "create";
      slug: string;
      title: string;
      description: string;
      body: string;
    }
  | {
      kind: "update";
      id: string;
      slug: string;
      expectedUpdatedAt: number;
      title: string;
      description: string;
      body: string;
    };
```

Snapshot `listMemories(db)` into `baseBySlug` and clone it into `currentBySlug`. `saveMemory` rejects an existing slug, adds a new overlay row, and marks the slug dirty. `updateMemory` rejects a missing slug, merges provided fields into the overlay, and marks the slug dirty. `readMemory` derives outgoing links with `extractLinks(body)`, incoming links by scanning the current overlay, and dangling links from missing targets. `mutations()` sorts dirty slugs lexically, emits full final values, and collapses a create followed by updates into one `create` mutation.

Tool descriptions must retain the existing durable-memory criteria, must say writes are staged until the report succeeds, and must not mention or expose delete/SOUL capabilities.

- [ ] **Step 4: Write failing repository transaction tests**

Add tests to `src/main/memory/repository.test.ts` and `src/main/reading-sessions/repository.test.ts`:

```ts
it("applies a report memory batch with links at one injected timestamp", () => {
  db.transaction((tx) => {
    applyReadingReportMemoryMutations(
      tx,
      [
        { kind: "create", slug: "a", title: "A", description: "A", body: "[[b]]" },
        { kind: "create", slug: "b", title: "B", description: "B", body: "B" },
      ],
      1_783_459_200_000,
    );
  });
  expect(getMemoryBySlug(db, "a")?.outgoing.map((memory) => memory.slug)).toEqual(["b"]);
  expect(getMemoryBySlug(db, "a")?.createdAt).toBe(1_783_459_200_000);
});

it("rejects an optimistic update when the original memory changed", () => {
  const original = createMemory(db, memoryInput);
  db.update(memories)
    .set({ body: "Changed elsewhere.", updatedAt: original.updatedAt + 1 })
    .where(eq(memories.id, original.id))
    .run();
  expect(() =>
    db.transaction((tx) =>
      applyReadingReportMemoryMutations(
        tx,
        [
          {
            kind: "update",
            id: original.id,
            slug: original.slug,
            expectedUpdatedAt: original.updatedAt,
            title: original.title,
            description: original.description,
            body: "Report update.",
          },
        ],
        original.updatedAt + 10,
      ),
    ),
  ).toThrow(/changed during reading report generation/);
});
```

For `saveReadingReportInTransaction`, open a transaction, save a report, throw a sentinel error, and assert after rollback that the session still contains the old report.

- [ ] **Step 5: Add transaction-aware repository primitives**

In `src/main/db/client.ts`, export the already-compatible executor shape used by Drizzle callbacks:

```ts
export type DBTransaction = Omit<DB, "$client">;
```

In `src/main/memory/repository.ts`, export:

```ts
export function applyReadingReportMemoryMutations(
  tx: DBTransaction,
  mutations: readonly ReadingReportMemoryMutation[],
  committedAt: number,
): void;
```

Apply all inserts and optimistic updates first, setting `createdAt`/`updatedAt` to `committedAt`, then call the existing `syncLinks` for every changed body so links between two memories created in the same batch resolve. Update mutations must use both `id` and `expectedUpdatedAt` in the `WHERE` clause and throw `memory <slug> changed during reading report generation` when no row is returned. Unique-slug insert errors propagate and roll back the outer transaction.

In `src/main/reading-sessions/repository.ts`, move current validation and update logic into:

```ts
export function saveReadingReportInTransaction(
  tx: DBTransaction,
  sessionId: string,
  content: string,
): ReadingSessionRow;
```

Keep the existing `saveReadingReport(db, sessionId, content)` public behavior by delegating to the new function.

- [ ] **Step 6: Run repository and workspace tests**

Run:

```bash
pnpm test src/main/reading-report/memory-workspace.test.ts src/main/memory/repository.test.ts src/main/reading-sessions/repository.test.ts
```

Expected: PASS.

- [ ] **Step 7: Write failing service atomicity tests**

Extend `src/main/reading-report/service.test.ts` with four cases using a `runAgent` stub that executes staged memory tools before resolving or rejecting:

```ts
const toolOptions = { toolCallId: "report-memory", messages: [] } as never;
const memoryInput = {
  slug: "durable-insight",
  title: "Durable insight",
  description: "A lasting insight from the reading.",
  body: "A durable insight.",
};

async function stageMemory(input: Parameters<typeof runReadingReportAgent>[0]) {
  const saveMemory = input.tools.saveMemory;
  if (!saveMemory?.execute) throw new Error("saveMemory tool missing");
  await saveMemory.execute(memoryInput, toolOptions);
}

it("commits the generated report and staged memory together", async () => {
  deps.runAgent = vi.fn(async (input) => {
    await stageMemory(input);
    return "# Report";
  });
  startReadingReportGeneration(deps, session.id);
  await drain();
  expect(getReadingSessionDetail(deps, session.id).report).toEqual({
    status: "ready",
    content: "# Report",
  });
  expect(getMemoryBySlug(deps.db, "durable-insight")?.body).toBe("A durable insight.");
});

it("discards staged memory when report generation fails", async () => {
  deps.runAgent = vi.fn(async (input) => {
    await stageMemory(input);
    throw new Error("model failed");
  });
  startReadingReportGeneration(deps, session.id);
  await drain();
  expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
});

it("discards staged memory from a generation invalidated by a manual save", async () => {
  const staged = deferred<void>();
  const finish = deferred<string>();
  deps.runAgent = vi.fn(async (input) => {
    await stageMemory(input);
    staged.resolve();
    return finish.promise;
  });
  startReadingReportGeneration(deps, session.id);
  await staged.promise;
  saveUserReadingReport(deps, session.id, "# Manual");
  finish.resolve("# Generated");
  await drain();
  expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
  expect(getReadingSessionDetail(deps, session.id).report).toEqual({
    status: "ready",
    content: "# Manual",
  });
});

it("rolls back the report when an optimistic memory update conflicts", async () => {
  const existing = createMemory(deps.db, memoryInput);
  saveReadingReport(deps.db, session.id, "# Old");
  const staged = deferred<void>();
  const finish = deferred<string>();
  deps.runAgent = vi.fn(async (input) => {
    const updateMemory = input.tools.updateMemory;
    if (!updateMemory?.execute) throw new Error("updateMemory tool missing");
    await updateMemory.execute({ slug: existing.slug, body: "Report update." }, toolOptions);
    staged.resolve();
    return finish.promise;
  });
  startReadingReportGeneration(deps, session.id);
  await staged.promise;
  deps.db
    .update(memories)
    .set({ body: "External update.", updatedAt: existing.updatedAt + 1 })
    .where(eq(memories.id, existing.id))
    .run();
  finish.resolve("# Generated");
  await drain();
  expect(getReadingSessionDetail(deps, session.id).report).toEqual({
    status: "regeneration-failed",
    content: "# Old",
  });
  expect(getMemoryBySlug(deps.db, "durable-insight")?.body).toBe("External update.");
});
```

- [ ] **Step 8: Compose tools and commit report plus memory in the service**

Change `RunReadingReportAgentInput.tools` to AI SDK `ToolSet` so the service can pass:

```ts
const memoryWorkspace = createReadingReportMemoryWorkspace(deps.db);
const tools = {
  ...createReadingReportTools(reportToolDeps),
  ...memoryWorkspace.tools,
};
```

Change the background result to `{ content, memoryMutations }`. After `runtime.isCurrent(...)` succeeds, commit with one synchronous transaction:

```ts
deps.db.transaction((tx) => {
  saveReadingReportInTransaction(tx, session.id, result.content);
  applyReadingReportMemoryMutations(tx, result.memoryMutations, deps.now().epochMilliseconds);
});
```

Add `now: () => Temporal.Instant` to `ReadingReportServiceDeps`. Tests inject a fixed instant; `makeReadingReportDeps()` in `src/main/ai/send-deps.ts` supplies `() => Temporal.Now.instant()`. Call `now()` only after the generation token is revalidated, immediately before the transaction.

Any transaction error follows the existing generation failure path and logs at `warn`; it must not mark the runtime successful.

- [ ] **Step 9: Run service tests and typecheck**

Run:

```bash
pnpm test src/main/reading-report/service.test.ts src/main/reading-report/memory-workspace.test.ts src/main/memory/repository.test.ts src/main/reading-sessions/repository.test.ts src/main/ai/send-deps.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit the atomic memory slice**

```bash
git add src/main/db/client.ts src/main/memory/repository.ts src/main/memory/repository.test.ts src/main/reading-sessions/repository.ts src/main/reading-sessions/repository.test.ts src/main/reading-report/agent.ts src/main/reading-report/memory-workspace.ts src/main/reading-report/memory-workspace.test.ts src/main/reading-report/service.ts src/main/reading-report/service.test.ts src/main/ai/send-deps.ts
git commit -m "feat: let reading reports organize memory"
```

---

### Task 10: Bound Conversation Evidence at the Compaction Frontier

**Files:**

- Modify: `src/main/reading-report/evidence.ts`
- Modify: `src/main/reading-report/evidence.test.ts`
- Modify: `src/main/reading-report/tools.ts`
- Modify: `src/main/reading-report/tools.test.ts`

**Interfaces:**

- Produces: `SessionConversationReadResult`, `SessionConversationReadOptions`, `SESSION_CONVERSATION_DEFAULT_LIMIT`, and `SESSION_CONVERSATION_TEXT_BUDGET`.
- Changes: `readSessionConversation(db, session, conversationId, options)` returns a discriminated result instead of an unbounded message array.
- Preserves: conversation ownership validation, session timestamp filtering, and at most one adjacent message before/after the session excerpt.

- [ ] **Step 1: Write failing compaction and pagination tests**

Extend `src/main/reading-report/evidence.test.ts` with fixtures that set `contextSummary` and `summarizedThroughSeq` on the existing conversation:

```ts
it("returns the compacted summary but never raw messages at or before its frontier", () => {
  db.update(conversations)
    .set({ contextSummary: "EARLY SUMMARY", summarizedThroughSeq: 1 })
    .where(eq(conversations.id, "conversation-in-window"))
    .run();

  const result = readSessionConversation(db, session, "conversation-in-window", {});

  if (result.status !== "messages") throw new Error("expected raw tail messages");
  expect(result.compactedContext).toEqual({ summary: "EARLY SUMMARY", throughSeq: 1 });
  expect(JSON.stringify(result)).not.toContain('"text":"before"');
  expect(JSON.stringify(result)).not.toContain('"text":"inside one"');
  expect(result.messages.map((message) => message.seq)).toEqual([2, 3]);
});

it("returns a compacted-only result when every in-session message is behind the frontier", () => {
  db.update(conversations)
    .set({ contextSummary: "ALL SESSION TURNS", summarizedThroughSeq: 2 })
    .where(eq(conversations.id, "conversation-in-window"))
    .run();

  expect(readSessionConversation(db, session, "conversation-in-window", {})).toEqual({
    status: "compacted-only",
    compactedContext: { summary: "ALL SESSION TURNS", throughSeq: 2 },
    messages: [],
  });
});

it("paginates uncompacted in-session messages with an exclusive seq cursor", () => {
  const first = readSessionConversation(db, session, "conversation-in-window", { limit: 1 });
  expect(first).toEqual(
    expect.objectContaining({ status: "messages", hasMore: true, nextAfterSeq: 1 }),
  );
  const second = readSessionConversation(db, session, "conversation-in-window", {
    afterSeq: 1,
    limit: 1,
  });
  expect(second).toEqual(
    expect.objectContaining({ status: "messages", hasMore: false, nextAfterSeq: null }),
  );
});
```

Add one fixture with a message longer than `SESSION_CONVERSATION_TEXT_BUDGET` and a neighbor assertion:

```ts
it("caps returned message text and marks truncation", () => {
  db.insert(messages)
    .values({
      conversationId: "conversation-in-window",
      role: "assistant",
      parts: [{ type: "text", text: "x".repeat(SESSION_CONVERSATION_TEXT_BUDGET + 100) }],
      seq: 4,
      createdAt: inside,
    })
    .run();
  const result = readSessionConversation(db, session, "conversation-in-window", {
    afterSeq: 3,
  });
  if (result.status !== "messages") throw new Error("expected raw tail messages");
  expect(result.messages[0]).toEqual(
    expect.objectContaining({
      seq: 4,
      truncated: true,
      text: "x".repeat(SESSION_CONVERSATION_TEXT_BUDGET),
    }),
  );
});

it("does not return a neighboring message at the compaction frontier", () => {
  db.update(conversations)
    .set({ contextSummary: "EARLY SUMMARY", summarizedThroughSeq: 1 })
    .where(eq(conversations.id, "conversation-in-window"))
    .run();
  const result = readSessionConversation(db, session, "conversation-in-window", {});
  if (result.status !== "messages") throw new Error("expected raw tail messages");
  expect(result.messages.some((message) => message.seq <= 1)).toBe(false);
});
```

In `src/main/reading-report/tools.test.ts`, assert `readConversation.inputSchema` defaults `limit` to 20, caps it at 50, accepts a non-negative `afterSeq`, and rejects 51.

- [ ] **Step 2: Run evidence and tool tests and verify RED**

Run:

```bash
pnpm test src/main/reading-report/evidence.test.ts src/main/reading-report/tools.test.ts
```

Expected: FAIL because the current function has no options, returns an array, crosses the compaction frontier, and exposes no bounded cursor schema.

- [ ] **Step 3: Define the discriminated conversation result**

In `src/main/reading-report/evidence.ts`, add:

```ts
export const SESSION_CONVERSATION_DEFAULT_LIMIT = 20;
export const SESSION_CONVERSATION_MAX_LIMIT = 50;
export const SESSION_CONVERSATION_TEXT_BUDGET = 24_000;

export interface SessionConversationReadOptions {
  afterSeq?: number;
  limit?: number;
}

export interface SessionConversationMessage extends SessionMessageExcerpt {
  context: "session" | "neighbor";
  truncated: boolean;
}

export type SessionConversationReadResult =
  | {
      status: "compacted-only";
      compactedContext: { summary: string; throughSeq: number };
      messages: [];
    }
  | {
      status: "messages";
      compactedContext: { summary: string; throughSeq: number } | null;
      messages: SessionConversationMessage[];
      hasMore: boolean;
      nextAfterSeq: number | null;
    };
```

The summary is included only on the first page (`afterSeq === undefined`) because prior tool results remain in the model context; later pages set `compactedContext` to `null`.

- [ ] **Step 4: Implement frontier-safe SQL, pagination, neighbors, and text budget**

Load only conversation metadata (`id`, `contextSummary`, `summarizedThroughSeq`) first. Build the raw predicate from all of:

```ts
eq(messages.conversationId, conversation.id),
gt(messages.seq, conversation.summarizedThroughSeq ?? -1),
gt(messages.seq, options.afterSeq ?? conversation.summarizedThroughSeq ?? -1),
gte(messages.createdAt, session.startedAt),
lte(messages.createdAt, session.completedAt!),
```

Query `limit + 1` ascending rows to derive `hasMore`; return only the first `limit`. On the first page, query at most one preceding neighbor whose seq is still greater than the compaction frontier. On the final page, query at most one following neighbor whose seq is greater than the frontier. Mark neighbors with `context: "neighbor"` and in-window rows with `context: "session"`.

Apply a cumulative 24,000-character budget after `textOfParts`. When a single included message exceeds remaining capacity, slice its text to the remaining characters and set `truncated: true`; never include another message after the budget is exhausted. Cursor progression uses the last in-session row selected from SQL, not a neighbor seq.

When no raw in-window row remains, use an ID-only/count query to distinguish “the session had messages, but they are compacted” from “the conversation has no session messages.” Return `compacted-only` only when a non-empty summary and numeric frontier exist; otherwise retain the existing no-session-messages error.

- [ ] **Step 5: Expose the cursor through the report tool**

Replace the `readConversation` input schema in `src/main/reading-report/tools.ts` with:

```ts
inputSchema: z.object({
  conversationId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(50).default(20),
}),
```

Pass `{ afterSeq, limit }` to `readSessionConversation`. Update the description to state that compacted history is returned only as a rolling summary and raw messages are paginated strictly after the frontier.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm test src/main/reading-report/evidence.test.ts src/main/reading-report/tools.test.ts src/main/reading-report/service.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the bounded conversation slice**

```bash
git add src/main/reading-report/evidence.ts src/main/reading-report/evidence.test.ts src/main/reading-report/tools.ts src/main/reading-report/tools.test.ts
git commit -m "fix: bound reading report conversation context"
```

---

### Task 11: Verify the Integrated Report Agent Refinement

**Files:**

- Modify only if a check exposes a defect: files changed in Tasks 8–10.

**Interfaces:**

- Consumes: live report prompt, staged memory workspace, atomic persistence, and bounded conversation evidence.
- Produces: automated evidence that the refinement does not regress ordinary chat context, report runtime states, or existing reading-session behavior.

- [ ] **Step 1: Run the complete report and memory test set**

Run:

```bash
pnpm test src/main/ai/agent-context.test.ts src/main/ai/base-prompt.test.ts src/main/ai/memory-tools.test.ts src/main/memory/repository.test.ts src/main/reading-sessions/repository.test.ts src/main/reading-report/prompt.test.ts src/main/reading-report/memory-workspace.test.ts src/main/reading-report/evidence.test.ts src/main/reading-report/tools.test.ts src/main/reading-report/service.test.ts src/main/ai/send-deps.test.ts
```

Expected: PASS with no unhandled rejection or logger output.

- [ ] **Step 2: Run the repository quality gates**

Run each separately:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm i18n:lint
```

Expected: tests, typecheck, lint, and format exit 0. `i18n:lint` must introduce no new findings; the known baseline is 12 pre-existing findings in ErrorBoundary (2), StreakCard (1), ChatPerfMonitor (8), and PdfReader (1).

- [ ] **Step 3: Inspect the final diff for scope and forbidden capabilities**

Run:

```bash
git diff --check c9267eb..HEAD
git diff --stat c9267eb..HEAD
rg -n "deleteMemory|updateSoul|in the reader's first person" src/main/reading-report
```

Expected: `git diff --check` is clean; changes are limited to the planned main-process/tests/docs files; the final `rg` returns no report-agent exposure of `deleteMemory`, `updateSoul`, or the old reader-first-person prompt.

- [ ] **Step 4: Record the completed incremental plan**

Mark Tasks 8–11 checkboxes complete only after their commands have produced the expected evidence, then commit the plan bookkeeping separately:

```bash
git add docs/superpowers/plans/2026-07-14-reading-sessions-completion-reports.md
git commit -m "docs: complete reading report agent refinement plan"
```
