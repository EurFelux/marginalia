# Cancellable Reading Report Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect an existing reading report behind an explicit regeneration confirmation and let users truly stop initial generation or regeneration without changing the stored report or memory.

**Architecture:** `ReadingReportRuntime` owns an `AbortController` for each claimed generation and invalidates the generation token before aborting it. The abort signal flows through the service into AI SDK `generateText`; stale or canceled completions cannot enter the existing atomic report-and-memory transaction. A typed cancel IPC command exposes idempotent cancellation, while the renderer confirms destructive regeneration and turns the busy action into a stop button.

**Tech Stack:** Electron 41, TypeScript 6, Zod 4 discriminated unions, AI SDK v6, React 19 with React Compiler, TanStack Query, shadcn AlertDialog, i18next, Vitest 4.

## Global Constraints

- Business cancellation, task ownership, and race protection stay in `src/main/`; the renderer only presents state and invokes typed commands.
- Shared IPC input/output validation remains sourced from Zod schemas in `src/shared/`.
- Cancellation is not a generation failure: it records no failure state, failure banner, or abort warning log.
- The current Markdown and staged memory remain unchanged until a complete current generation commits them in one transaction.
- No report version table, candidate draft, undo history, or migration is introduced.
- New UI copy is present and non-empty in both `zh-CN` and `en`.
- New code uses existing project loggers and introduces no raw `console.*`, hand-written React memoization, or static inline styles.

---

### Task 1: Make report generations abortable and race-safe

**Files:**
- Modify: `src/main/reading-report/runtime.ts`
- Modify: `src/main/reading-report/agent.ts`
- Modify: `src/main/reading-report/service.ts`
- Test: `src/main/reading-report/service.test.ts`

**Interfaces:**
- Produces: `GenerationClaim = { generation: number; signal: AbortSignal }` from `ReadingReportRuntime.claim(sessionId, kind)`.
- Produces: `ReadingReportRuntime.cancel(sessionId): boolean`, which invalidates first, aborts second, and returns whether work existed.
- Produces: `cancelReadingReportGeneration(deps, sessionId)` with the inferred discriminated result `{ outcome: "canceled" } | { outcome: "idle" }`; Task 2 promotes that result to the shared Zod contract.
- Changes: `RunReadingReportAgentInput` gains `abortSignal: AbortSignal`; `runReadingReportAgent` passes it to `generateText`.

- [ ] **Step 1: Write failing service tests for cancellation and completion races**

Add `cancelReadingReportGeneration` to the service imports and add tests that capture the injected signal, stage memory, cancel both initial generation and regeneration, and resolve the old promise after cancellation:

```ts
it.each([
  { options: {}, expected: { status: "empty" } },
  { options: { report: "# Old" }, expected: { status: "ready", content: "# Old" } },
])("cancels generation without changing the stored report", async ({ options, expected }) => {
  warn.mockClear();
  const { deps, session, task, drain } = setup(options);
  let signal: AbortSignal | undefined;
  deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
  deps.runAgent = vi.fn((input) => {
    signal = input.abortSignal;
    return task.promise;
  });

  startReadingReportGeneration(deps, session.id);
  expect(cancelReadingReportGeneration(deps, session.id)).toEqual({ outcome: "canceled" });
  expect(signal?.aborted).toBe(true);
  expect(getReadingSessionDetail(deps, session.id).report).toEqual(expected);
  expect(cancelReadingReportGeneration(deps, session.id)).toEqual({ outcome: "idle" });

  task.resolve("# Late result");
  await drain();
  expect(getReadingSessionDetail(deps, session.id).report).toEqual(expected);
  expect(warn).not.toHaveBeenCalled();
});

it("discards staged memory when cancellation races with completion", async () => {
  const { deps, session, drain } = setup({ report: "# Old" });
  const staged = deferred<void>();
  const finish = deferred<string>();
  deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
  deps.runAgent = vi.fn(async (input) => {
    await executeAgentTool(input, "saveMemory", memoryInput);
    staged.resolve();
    return finish.promise;
  });

  startReadingReportGeneration(deps, session.id);
  await staged.promise;
  cancelReadingReportGeneration(deps, session.id);
  finish.resolve("# Late result");
  await drain();

  expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
  expect(getReadingSessionDetail(deps, session.id).report).toEqual({
    status: "ready",
    content: "# Old",
  });
});
```

Clear `warn` at each cancellation test start so the assertion only covers that operation.

- [ ] **Step 2: Run the focused service tests and verify they fail**

Run: `pnpm test src/main/reading-report/service.test.ts`

Expected: FAIL because `cancelReadingReportGeneration` and `RunReadingReportAgentInput.abortSignal` do not exist.

- [ ] **Step 3: Add abort ownership to `ReadingReportRuntime`**

Add a private controller map and return a claim object:

```ts
export interface GenerationClaim {
  generation: number;
  signal: AbortSignal;
}

readonly #controllers = new Map<string, AbortController>();

claim(sessionId: string, kind: GenerationKind): GenerationClaim | undefined {
  if (this.inFlight.has(sessionId)) return undefined;
  const generation = (this.#generations.get(sessionId) ?? 0) + 1;
  const controller = new AbortController();
  this.#generations.set(sessionId, generation);
  this.#controllers.set(sessionId, controller);
  this.failures.delete(sessionId);
  this.inFlight.set(sessionId, kind);
  return { generation, signal: controller.signal };
}
```

Make `fail` and `succeed` delete the matching controller when they clear `inFlight`. Implement cancellation so invalidation happens before the abort event can settle the promise:

```ts
cancel(sessionId: string): boolean {
  const controller = this.#controllers.get(sessionId);
  if (!controller) return false;
  this.#generations.set(sessionId, (this.#generations.get(sessionId) ?? 0) + 1);
  this.#controllers.delete(sessionId);
  this.inFlight.delete(sessionId);
  this.failures.delete(sessionId);
  controller.abort();
  return true;
}
```

Update `invalidate` to call the same internal invalidation-and-abort path when a user save supersedes work, while preserving its existing behavior when no controller exists.

- [ ] **Step 4: Thread the abort signal through the agent**

Extend the input and AI SDK call:

```ts
export interface RunReadingReportAgentInput {
  // existing fields
  abortSignal: AbortSignal;
}

const result = await generateText({
  // existing options
  abortSignal: input.abortSignal,
});
```

- [ ] **Step 5: Add service cancellation and suppress stale abort failures**

Use the claim object in `startReadingReportGeneration`, check an already-aborted queued task before creating report tools, and pass the signal to the agent:

```ts
const claim = deps.runtime.claim(sessionId, kind);
if (claim == null) return { outcome: "accepted" };

void deps.runBackground(async () => {
  claim.signal.throwIfAborted();
  // build tools and memory workspace
  const content = await deps.runAgent({
    // existing arguments
    abortSignal: claim.signal,
  });
  return { content, memoryMutations: memoryWorkspace.mutations() };
});
```

Use `claim.generation` for current-generation checks. In the rejection callback, return before logging when that generation is no longer current:

```ts
.catch((err: unknown) => {
  if (!deps.runtime.isCurrent(session.id, claim.generation)) return;
  log.warn(`generation failed for session ${session.id}`, err);
  deps.runtime.fail(session.id, { kind }, claim.generation);
});
```

Add the pure service entry point:

```ts
export function cancelReadingReportGeneration(
  deps: Pick<ReadingReportServiceDeps, "db" | "runtime">,
  sessionId: string,
) {
  completedSession(deps.db, sessionId);
  return deps.runtime.cancel(sessionId) ? { outcome: "canceled" } : { outcome: "idle" };
}
```

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `pnpm test src/main/reading-report/service.test.ts`

Expected: PASS with no abort warning assertion failure.

- [ ] **Step 7: Commit the main-process cancellation behavior**

```bash
git add src/main/reading-report/runtime.ts src/main/reading-report/agent.ts src/main/reading-report/service.ts src/main/reading-report/service.test.ts
git commit -m "feat: cancel reading report generation"
```

### Task 2: Expose typed idempotent cancellation over IPC

**Files:**
- Modify: `src/shared/reading-sessions.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/reading-report/service.ts`
- Modify: `src/main/ipc/reading-sessions-handlers.ts`
- Modify: `src/main/ipc/reading-sessions-handlers.test.ts`
- Modify: `src/preload-api.ts`
- Modify: `src/preload-api.test.ts`

**Interfaces:**
- Consumes: `cancelReadingReportGeneration(deps, sessionId)` from Task 1.
- Produces: `cancelReadingReportResultSchema` and `CancelReadingReportResult`, discriminated by `outcome: "canceled" | "idle"`.
- Produces: contract `C.readingSessionsCancelReport` on channel `reading-sessions:cancel-report`.
- Produces: renderer API `window.api.readingSessions.cancelReport({ sessionId })` for Task 3.

- [ ] **Step 1: Write failing shared/preload/handler tests**

In `src/preload-api.test.ts`, call cancellation between generate and save and assert the exact channel/order:

```ts
await api.readingSessions.cancelReport({ sessionId: "s1" });
expect(invoke).toHaveBeenNthCalledWith(6, C.readingSessionsCancelReport.channel, {
  sessionId: "s1",
});
```

Move the save assertion to call 7. In the handler test mock, expose `cancelReadingReportGeneration: vi.fn()`, find the `reading-sessions:cancel-report` binding, invoke it, and assert it receives `makeReadingReportDeps()` plus the session ID.

- [ ] **Step 2: Run contract boundary tests and verify they fail**

Run: `pnpm test src/preload-api.test.ts src/main/ipc/reading-sessions-handlers.test.ts`

Expected: FAIL because the cancel contract and API member do not exist.

- [ ] **Step 3: Define the discriminated cancellation result and IPC contract**

In `src/shared/reading-sessions.ts` add:

```ts
export const cancelReadingReportResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("canceled") }),
  z.object({ outcome: z.literal("idle") }),
]);
export type CancelReadingReportResult = z.infer<typeof cancelReadingReportResultSchema>;
```

Import `CancelReadingReportResult` in `src/main/reading-report/service.ts` and annotate the Task 1 service function with that return type so the domain result and IPC contract cannot drift.

Import the type in `src/shared/ipc.ts` and define:

```ts
readingSessionsCancelReport: def(
  "reading-sessions:cancel-report",
  "invoke",
  readingSessionIdInput,
  out<CancelReadingReportResult>(),
),
```

- [ ] **Step 4: Wire handler and preload API**

Register the service call in `readingSessionBindings`:

```ts
bind(C.readingSessionsCancelReport, (input) =>
  cancelReadingReportGeneration(makeReadingReportDeps(), input.sessionId),
),
```

Expose it beside `generateReport`:

```ts
cancelReport: inv(C.readingSessionsCancelReport),
```

- [ ] **Step 5: Run boundary tests and typecheck**

Run: `pnpm test src/preload-api.test.ts src/main/ipc/reading-sessions-handlers.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the cancel contract**

```bash
git add src/shared/reading-sessions.ts src/shared/ipc.ts src/main/reading-report/service.ts src/main/ipc/reading-sessions-handlers.ts src/main/ipc/reading-sessions-handlers.test.ts src/preload-api.ts src/preload-api.test.ts
git commit -m "feat: expose reading report cancellation"
```

### Task 3: Confirm regeneration and turn busy generation into a stop action

**Files:**
- Modify: `src/renderer/reading/report-view-model.ts`
- Test: `src/renderer/reading/report-view-model.test.ts`
- Modify: `src/renderer/reading/ReadingReportView.tsx`
- Test: `src/renderer/reading/ReadingReportView.test.ts`
- Modify: `src/shared/i18n/locales/zh-CN.ts`
- Modify: `src/shared/i18n/locales/en.ts`
- Modify: `src/shared/i18n/locales.test.ts`

**Interfaces:**
- Consumes: `window.api.readingSessions.cancelReport({ sessionId })` from Task 2.
- Changes: `ReportViewModel` adds `canCancel: boolean`; it is true only for `generating` and `regenerating`.
- UI behavior: ready/regeneration-failed regeneration opens confirmation; initial/retry starts immediately; busy action invokes cancellation.

- [ ] **Step 1: Write failing view-model and component tests**

Extend every expected view model with `canCancel`; only the two busy states use `true`. In `ReadingReportView.test.ts`, make the alert mock honor `open`, add hoisted `generateReport`, `cancelReport`, and query-client spies, and let the detail query read a mutable `reportState`.

Add a confirmation test:

```ts
it("confirms before replacing an existing report", async () => {
  renderReport();
  clickButton("readingReport.regenerate");
  expect(generateReport).not.toHaveBeenCalled();
  expect(host.textContent).toContain("readingReport.regenerateConfirmTitle");

  await clickButton("readingReport.confirmRegenerate");
  expect(generateReport).toHaveBeenCalledWith({ sessionId: "session-1" });
});
```

Add a busy cancellation test:

```ts
it("stops regeneration while keeping the old report visible", async () => {
  reportState = { status: "regenerating", content: "# Report" };
  cancelReport.mockResolvedValue({ outcome: "canceled" });
  renderReport();

  expect(host.querySelector("[data-testid='report-body']")?.textContent).toBe("# Report");
  await clickButton("readingReport.stopRegenerating");

  expect(cancelReport).toHaveBeenCalledWith({ sessionId: "session-1" });
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["reading-session", "session-1"],
  });
  expect(toast.info).toHaveBeenCalledWith("readingReport.generationStopped");
});
```

Also test that an `empty`/`generation-failed` action invokes generation without opening the replacement dialog, and that a rejected cancellation logs a warning plus a localized persistent error toast without leaking the exception text.

- [ ] **Step 2: Run renderer tests and verify they fail**

Run: `pnpm test src/renderer/reading/report-view-model.test.ts src/renderer/reading/ReadingReportView.test.ts`

Expected: FAIL because cancellation state, confirmation copy, and handlers are absent.

- [ ] **Step 3: Add the view-model cancellation projection**

Add `canCancel` to the interface and return values:

```ts
export interface ReportViewModel {
  // existing fields
  canCancel: boolean;
}
```

Use `canCancel: true` for `generating` and `regenerating`, and `false` for every stable or failed state.

- [ ] **Step 4: Implement confirm, start, and stop handlers in the report view**

Add `Square` to the Lucide imports and `regenerateOpen` state. Split the current generation action into:

```ts
const requestGenerate = () => {
  if (detail.data?.report.status === "ready" ||
      detail.data?.report.status === "regeneration-failed") {
    setRegenerateOpen(true);
    return;
  }
  void generate();
};

const cancelGeneration = async () => {
  if (!selectedSession) return;
  try {
    const result = await window.api.readingSessions.cancelReport({
      sessionId: selectedSession.id,
    });
    await qc.invalidateQueries({ queryKey: qk.readingSession(selectedSession.id) });
    if (result.outcome === "canceled") toast.info(t("readingReport.generationStopped"));
  } catch (error) {
    log.warn("cancel reading report generation failed", error);
    showError(t("readingReport.cancelFailed"));
  }
};
```

The footer action uses `model.canCancel ? cancelGeneration : requestGenerate`, stays enabled while busy, uses an outline stop treatment and `Square` icon while cancelable, and chooses `stopGenerating` versus `stopRegenerating` from whether `model.content` exists.

Add a second controlled `AlertDialog` after the reread dialog. Its copy explains that successful regeneration replaces the existing report, its secondary action closes the dialog and keeps the current report, and its primary action closes the dialog before calling `generate()`.

- [ ] **Step 5: Add localized UX copy and completeness coverage**

Add these exact Chinese meanings with natural English equivalents:

```ts
"readingReport.cancelFailed": "暂时无法停止生成，请重试。",
"readingReport.confirmRegenerate": "重新生成并替换",
"readingReport.generationStopped": "已停止生成，现有报告已保留。",
"readingReport.keepCurrent": "保留现有报告",
"readingReport.regenerateConfirmDescription": "新报告生成成功后会替换当前内容；生成期间当前报告仍会保留。",
"readingReport.regenerateConfirmTitle": "重新生成这份报告？",
"readingReport.stopGenerating": "停止生成",
"readingReport.stopRegenerating": "停止重新生成",
```

Append all eight base keys to `task6ReadingKeys` in `src/shared/i18n/locales.test.ts`.

- [ ] **Step 6: Run renderer, locale, and type tests**

Run: `pnpm test src/renderer/reading/report-view-model.test.ts src/renderer/reading/ReadingReportView.test.ts src/shared/i18n/locales.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the polished regeneration UX**

```bash
git add src/renderer/reading/report-view-model.ts src/renderer/reading/report-view-model.test.ts src/renderer/reading/ReadingReportView.tsx src/renderer/reading/ReadingReportView.test.ts src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts src/shared/i18n/locales.test.ts
git commit -m "feat: protect and stop reading report regeneration"
```

### Task 4: Verify the complete UX refinement

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Consumes: all behavior produced by Tasks 1–3.
- Produces: a verified branch where cancellation is typed, race-safe, localized, and usable.

- [ ] **Step 1: Run focused report and boundary suites together**

Run:

```bash
pnpm test src/main/reading-report/service.test.ts src/main/ipc/reading-sessions-handlers.test.ts src/preload-api.test.ts src/renderer/reading/report-view-model.test.ts src/renderer/reading/ReadingReportView.test.ts src/shared/i18n/locales.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm i18n:lint
```

Expected: test/typecheck/lint/format pass. If `i18n:lint` still reports only the repository's pre-existing 12 findings (ErrorBoundary 2, StreakCard 1, ChatPerfMonitor 8, PdfReader 1), record that unchanged baseline rather than broadening this change.

- [ ] **Step 3: Inspect the final diff for scope and unsafe patterns**

Run:

```bash
git diff --check
git diff --stat HEAD~3..HEAD
rg -n "console\\.|useMemo|useCallback|style=\\{\\{" src/main/reading-report src/renderer/reading src/shared/reading-sessions.ts
```

Expected: no whitespace errors, no unrelated files, and no new forbidden patterns.

- [ ] **Step 4: Commit any verification-only corrections**

If verification required changes, stage only the affected files and use:

```bash
git commit -m "fix: harden reading report cancellation"
```

If no correction was needed, do not create an empty commit.
