# Reading Sessions and Completion Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit reading sessions, session-aware reading time, and editable AI-generated completion reports centered on the reader's own traces.

**Architecture:** Introduce `reading_sessions` as the durable lifecycle boundary while keeping `reading_daily` as the only reading-time fact table. Main-process repositories own session state, evidence queries, report generation, and AI tools; shared Zod contracts drive IPC; renderer routes a book to start, active-reader, reference-reader, or completion-report views from derived session state.

**Tech Stack:** Electron 41.7.1, TypeScript 6, React 19 with React Compiler, Zustand, TanStack Query, Zod 4, Drizzle ORM 1.0.0-rc.3, SQLite/better-sqlite3, Vercel AI SDK 7, Vitest 4, Tailwind CSS 4, CodeMirror 6, Streamdown.

## Global Constraints

- Keep all business logic in `src/main/`; renderer code only displays shared DTOs and invokes IPC.
- Use the configured summary model for report generation; never fall back to the chat model.
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
