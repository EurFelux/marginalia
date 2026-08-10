# 阅读报告生成进度反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让阅读报告生成期间在报告卡片里显示一条实时活动时间线（每个工具调用一条，带耗时计时与结果计数），失败时保留以供诊断。

**Architecture:** 主进程用一个 ToolSet 装饰器 `withProgress` 在每个工具 `execute` 的入口/出口上报结构化事件，事件存进 `ReadingReportRuntime` 的按 session 环形缓冲；事件随现成的 `readingSessions.get` DTO 经既有 400ms 轮询到达渲染层；渲染层把结构化事件映射为 i18n 文案并画成时间线。全部计时在客户端算。

**Tech Stack:** TypeScript 6 strict、Vercel AI SDK v6（`ToolSet` / `Tool`）、Zod 4、React 19（含 React Compiler）、i18next、vitest 4（跑在 Electron 运行时）、Tailwind。

## Global Constraints

- 业务逻辑一律在主进程（`src/main/`）；渲染层只做 UI。
- 日期时间用 `Temporal`，**不用 `Date`**；读系统时钟（`Temporal.Now.*`）只允许出现在胶水层，纯函数收注入的时钟。
- 日志用 `createLogger`，禁止裸 `console.*`；本计划不新增日志调用。
- **不新增 IPC 通道**，复用 `reading-sessions:get`。
- 样式优先 Tailwind 工具类；内联 `style={{}}` 仅用于运行时计算值。
- **不要手写 `useCallback` / `useMemo`**（渲染层启用 React Compiler）。
- i18n 文案同时写入 `src/shared/i18n/locales/en.ts` 与 `src/shared/i18n/locales/zh-CN.ts`，两个文件的 key 均按字母序插入。
- 时间线环形缓冲上限 **50** 条。
- 事件的 `outcome` 只有两种：`"ok"` 与 `"skipped"`（软失败/降级），**没有** `"error"`。
- 验证命令：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm i18n:lint`。

---

### Task 1: 共享 DTO 与 runtime 进度存储

**Files:**

- Modify: `src/shared/reading-sessions.ts:20-32`（`readingReportStateSchema` 一段）
- Modify: `src/main/reading-report/runtime.ts`
- Test: `src/main/reading-report/runtime.test.ts`（新建）

**Interfaces:**

- Consumes: 无（本计划第一个任务）
- Produces:
  - `ReadingReportProgressStep = { id: string; tool: string; startedAt: number; endedAt: number | null; outcome: "ok" | "skipped" | null; count: number | null }`（从 `@shared/reading-sessions` 导出）
  - `ReadingReportProgressOutcome = "ok" | "skipped"`（从 `@shared/reading-sessions` 导出）
  - `ReadingReportState` 的 `generating` / `regenerating` 变体新增 `startedAt: number` 与 `progress: ReadingReportProgressStep[]`；`generation-failed` / `regeneration-failed` 变体新增 `progress: ReadingReportProgressStep[]`
  - `ProgressSink = { start(tool: string): string; finish(id: string, outcome: ReadingReportProgressOutcome, count: number | null): void }`（从 `@main/reading-report/runtime` 导出）
  - `new ReadingReportRuntime(now?: () => number)` —— 构造函数可注入毫秒时钟，默认 `() => Temporal.Now.instant().epochMilliseconds`
  - `runtime.sink(sessionId: string, generation: number): ProgressSink`

- [ ] **Step 1: 扩展共享 schema**

编辑 `src/shared/reading-sessions.ts`，把第 20–32 行的 `markdown` / `readingReportStateSchema` 一段整体替换为：

```ts
const markdown = z.string().trim().min(1);

export const readingReportProgressOutcomeSchema = z.enum(["ok", "skipped"]);
export type ReadingReportProgressOutcome = z.infer<typeof readingReportProgressOutcomeSchema>;

export const readingReportProgressStepSchema = z.object({
  /** 一次生成内自增的序号，仅用作渲染层列表 key。 */
  id: z.string().min(1),
  /** 工具名，渲染层据此查 i18n 文案；未知工具名回退到通用文案。 */
  tool: z.string().min(1),
  startedAt: z.number().int(),
  /** null = 仍在进行中。 */
  endedAt: z.number().int().nullable(),
  outcome: readingReportProgressOutcomeSchema.nullable(),
  /** 可从工具输出里抽到的条目数，抽不到为 null。 */
  count: z.number().int().nullable(),
});
export type ReadingReportProgressStep = z.infer<typeof readingReportProgressStepSchema>;

const progress = z.array(readingReportProgressStepSchema);

export const readingReportStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("generating"), startedAt: z.number().int(), progress }),
  z.object({ status: z.literal("generation-failed"), progress }),
  z.object({ status: z.literal("ready"), content: markdown }),
  z.object({
    status: z.literal("regenerating"),
    content: markdown,
    startedAt: z.number().int(),
    progress,
  }),
  z.object({ status: z.literal("regeneration-failed"), content: markdown, progress }),
]);
export type ReadingReportState = z.infer<typeof readingReportStateSchema>;
```

注意：原文件第 20 行已有 `const markdown = ...`，替换后不要留下重复定义。

- [ ] **Step 2: 写失败的 runtime 测试**

新建 `src/main/reading-report/runtime.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ReadingReportRuntime } from "@main/reading-report/runtime";

/** 固定时钟：每次读取推进 1000ms，让断言里的时间戳可预期。 */
function fakeClock(start = 1_000) {
  let now = start;
  return () => {
    const value = now;
    now += 1000;
    return value;
  };
}

describe("ReadingReportRuntime progress", () => {
  it("records a step from start to finish and exposes it on generating state", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);

    const id = sink.start("listAnnotations");
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: 1_000,
      progress: [
        {
          id,
          tool: "listAnnotations",
          startedAt: 2_000,
          endedAt: null,
          outcome: null,
          count: null,
        },
      ],
    });

    sink.finish(id, "ok", 24);
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: 1_000,
      progress: [
        {
          id,
          tool: "listAnnotations",
          startedAt: 2_000,
          endedAt: 3_000,
          outcome: "ok",
          count: 24,
        },
      ],
    });
  });

  it("keeps concurrent steps side by side", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);

    const first = sink.start("investigateConversation");
    const second = sink.start("investigateConversation");
    expect(first).not.toEqual(second);

    sink.finish(second, "skipped", null);
    const state = runtime.state("s1", null);
    expect(state.status).toEqual("generating");
    const steps = state.status === "generating" ? state.progress : [];
    expect(steps.map((step) => step.outcome)).toEqual([null, "skipped"]);
  });

  it("clears progress on claim, success, cancel and invalidate but keeps it on failure", () => {
    const runtime = new ReadingReportRuntime(fakeClock());

    const first = runtime.claim("s1", "initial")!;
    runtime.sink("s1", first.generation).start("listConversations");
    runtime.fail("s1", { kind: "initial" }, first.generation);
    const failed = runtime.state("s1", null);
    expect(failed.status).toEqual("generation-failed");
    expect(failed.status === "generation-failed" ? failed.progress.length : 0).toEqual(1);

    const second = runtime.claim("s1", "initial")!;
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: expect.any(Number),
      progress: [],
    });
    runtime.sink("s1", second.generation).start("listConversations");
    runtime.succeed("s1", second.generation);
    expect(runtime.state("s1", "# Report")).toEqual({ status: "ready", content: "# Report" });

    const third = runtime.claim("s1", "initial")!;
    runtime.sink("s1", third.generation).start("listConversations");
    runtime.cancel("s1");
    expect(runtime.state("s1", null)).toEqual({ status: "empty" });

    const fourth = runtime.claim("s1", "initial")!;
    runtime.sink("s1", fourth.generation).start("listConversations");
    runtime.invalidate("s1");
    expect(runtime.state("s1", null)).toEqual({ status: "empty" });
  });

  it("drops the oldest steps beyond the 50 entry cap", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);
    for (let i = 0; i < 60; i++) sink.start(`tool${i}`);

    const state = runtime.state("s1", null);
    const steps = state.status === "generating" ? state.progress : [];
    expect(steps).toHaveLength(50);
    expect(steps[0]?.tool).toEqual("tool10");
    expect(steps.at(-1)?.tool).toEqual("tool59");
  });

  it("ignores a sink bound to a superseded generation", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const stale = runtime.claim("s1", "initial")!;
    const staleSink = runtime.sink("s1", stale.generation);
    runtime.invalidate("s1");
    const fresh = runtime.claim("s1", "initial")!;

    staleSink.start("listAnnotations");
    const state = runtime.state("s1", null);
    expect(state.status === "generating" ? state.progress : []).toEqual([]);
    expect(fresh.generation).toBeGreaterThan(stale.generation);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test src/main/reading-report/runtime.test.ts`
Expected: FAIL —— `runtime.sink is not a function`，且 `state()` 返回值缺少 `startedAt` / `progress`。

- [ ] **Step 4: 实现 runtime 进度存储**

编辑 `src/main/reading-report/runtime.ts`。

顶部 import 改为：

```ts
import type {
  ReadingReportProgressOutcome,
  ReadingReportProgressStep,
  ReadingReportState,
} from "@shared/reading-sessions";
```

在 `hasReport` 之后加入：

```ts
/** 40 步的工具上限 + 余量；防异常循环把内存撑爆。 */
const PROGRESS_LIMIT = 50;

export interface ProgressSink {
  /** 工具开始执行；返回的 id 用于配对 finish。 */
  start(tool: string): string;
  finish(id: string, outcome: ReadingReportProgressOutcome, count: number | null): void;
}

interface ProgressRun {
  startedAt: number;
  steps: ReadingReportProgressStep[];
  nextId: number;
}
```

类内新增字段与构造函数（放在 `#controllers` 之后）：

```ts
  readonly #progress = new Map<string, ProgressRun>();
  readonly #now: () => number;

  constructor(now: () => number = () => Temporal.Now.instant().epochMilliseconds) {
    this.#now = now;
  }
```

`state()` 整体替换为：

```ts
  state(sessionId: string, storedReport: string | null): ReadingReportState {
    const run = this.#progress.get(sessionId);
    const kind = this.inFlight.get(sessionId);
    if (kind) {
      const live = { startedAt: run?.startedAt ?? this.#now(), progress: run?.steps ?? [] };
      return hasReport(storedReport)
        ? { status: "regenerating", content: storedReport.trim(), ...live }
        : { status: "generating", ...live };
    }
    const failure = this.failures.get(sessionId);
    if (failure) {
      const progress = run?.steps ?? [];
      return hasReport(storedReport)
        ? { status: "regeneration-failed", content: storedReport.trim(), progress }
        : { status: "generation-failed", progress };
    }
    return hasReport(storedReport)
      ? { status: "ready", content: storedReport.trim() }
      : { status: "empty" };
  }
```

`claim()` 中，在 `this.inFlight.set(sessionId, kind);` 之前插入一行：

```ts
this.#progress.set(sessionId, { startedAt: this.#now(), steps: [], nextId: 1 });
```

`succeed()` 中，在 `this.failures.delete(sessionId);` 之后插入：

```ts
this.#progress.delete(sessionId);
```

`#invalidate()` 中，在 `this.failures.delete(sessionId);` 之后插入同样一行 `this.#progress.delete(sessionId);`（这同时覆盖 `cancel()` 与 `invalidate()`；`fail()` 不动，故失败时时间线保留）。

在 `#invalidate` 之前新增 `sink` 方法：

```ts
  /**
   * 绑定到某一次生成的进度出口。generation 不再是当前世代时全部调用变成空操作，
   * 免得被顶掉的旧生成把事件写进新生成的时间线。
   */
  sink(sessionId: string, generation: number): ProgressSink {
    return {
      start: (tool) => {
        const run = this.#progress.get(sessionId);
        if (!run || !this.isCurrent(sessionId, generation)) return "";
        const id = String(run.nextId++);
        run.steps.push({
          id,
          tool,
          startedAt: this.#now(),
          endedAt: null,
          outcome: null,
          count: null,
        });
        if (run.steps.length > PROGRESS_LIMIT) {
          run.steps.splice(0, run.steps.length - PROGRESS_LIMIT);
        }
        return id;
      },
      finish: (id, outcome, count) => {
        const step = this.#progress.get(sessionId)?.steps.find((entry) => entry.id === id);
        if (!step) return;
        step.endedAt = this.#now();
        step.outcome = outcome;
        step.count = count;
      },
    };
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test src/main/reading-report/runtime.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 6: 修复因 DTO 变更而失败的既有测试**

`src/main/reading-report/service.test.ts` 里有 `toEqual({ status: "generating" })` 之类的断言，现在会因多出 `startedAt` / `progress` 而失败。

先把 `setup()` 里的 `runtime: new ReadingReportRuntime(),`（约第 97 行）改成注入固定时钟：

```ts
    runtime: new ReadingReportRuntime(() => instant("2026-07-03T00:00:00Z").epochMilliseconds),
```

再把断言补齐字段。第 119 行：

```ts
expect(getReadingSessionDetail(deps, session.id).report).toEqual({
  status: "generating",
  startedAt: instant("2026-07-03T00:00:00Z").epochMilliseconds,
  progress: [],
});
```

第 132 行：

```ts
expect(getReadingSessionDetail(deps, session.id).report).toEqual({
  status: "regenerating",
  content: "# Old",
  startedAt: instant("2026-07-03T00:00:00Z").epochMilliseconds,
  progress: [],
});
```

Run: `pnpm test src/main/reading-report/` —— 逐条把仍失败的断言按同样方式补上 `progress: []`（失败态）或 `startedAt` + `progress: []`（进行态）。`ready` / `empty` 断言不需要改。

- [ ] **Step 7: 全量验证并提交**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add src/shared/reading-sessions.ts src/main/reading-report/runtime.ts src/main/reading-report/runtime.test.ts src/main/reading-report/service.test.ts
git commit -m "feat(report): record per-tool generation progress in the report runtime"
```

---

### Task 2: `withProgress` 工具装饰器

**Files:**

- Create: `src/main/reading-report/progress.ts`
- Test: `src/main/reading-report/progress.test.ts`

**Interfaces:**

- Consumes: `ProgressSink`、`ReadingReportProgressOutcome`（Task 1）
- Produces:
  - `withProgress<T extends ToolSet>(tools: T, sink: ProgressSink): T`
  - `progressCount(output: unknown): number | null`
  - `progressOutcome(output: unknown): ReadingReportProgressOutcome`

- [ ] **Step 1: 写失败的测试**

新建 `src/main/reading-report/progress.test.ts`：

```ts
import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ProgressSink } from "@main/reading-report/runtime";
import { progressCount, progressOutcome, withProgress } from "@main/reading-report/progress";

interface Event {
  id: string;
  tool: string;
  outcome: string | null;
  count: number | null;
}

function recordingSink() {
  const events: Event[] = [];
  let next = 0;
  const sink: ProgressSink = {
    start: (name) => {
      const id = String(++next);
      events.push({ id, tool: name, outcome: null, count: null });
      return id;
    },
    finish: (id, outcome, count) => {
      const event = events.find((entry) => entry.id === id);
      if (event) {
        event.outcome = outcome;
        event.count = count;
      }
    },
  };
  return { sink, events };
}

const noInput = z.object({});

describe("progressCount", () => {
  it("reads items, then messages, and gives up otherwise", () => {
    expect(progressCount({ items: [1, 2, 3], hasMore: false })).toEqual(3);
    expect(progressCount({ messages: [1, 2], hasMore: true })).toEqual(2);
    expect(progressCount({ activeSeconds: 90 })).toBeNull();
    expect(progressCount("plain text")).toBeNull();
    expect(progressCount(null)).toBeNull();
  });
});

describe("progressOutcome", () => {
  it("treats swallowed tool errors and delegation fallbacks as skipped", () => {
    expect(progressOutcome({ items: [] })).toEqual("ok");
    expect(progressOutcome({ error: "conversation not found" })).toEqual("skipped");
    expect(progressOutcome({ status: "busy", suggestion: "read it yourself" })).toEqual("skipped");
    expect(progressOutcome({ status: "failed", suggestion: "read it yourself" })).toEqual(
      "skipped",
    );
    expect(progressOutcome({ status: "ok", highlights: [] })).toEqual("ok");
  });
});

describe("withProgress", () => {
  it("passes the tool output through untouched while reporting a finished step", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        listAnnotations: tool({
          description: "list",
          inputSchema: noInput,
          execute: async () => ({ items: [1, 2, 3], hasMore: false }),
        }),
      },
      sink,
    );

    const output = await wrapped.listAnnotations.execute!({}, {} as never);

    expect(output).toEqual({ items: [1, 2, 3], hasMore: false });
    expect(events).toEqual([{ id: "1", tool: "listAnnotations", outcome: "ok", count: 3 }]);
  });

  it("still finishes the step when the tool throws, and rethrows", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        readConversation: tool({
          description: "read",
          inputSchema: noInput,
          execute: async () => {
            throw new Error("boom");
          },
        }),
      },
      sink,
    );

    await expect(wrapped.readConversation.execute!({}, {} as never)).rejects.toThrow("boom");
    expect(events).toEqual([
      { id: "1", tool: "readConversation", outcome: "skipped", count: null },
    ]);
  });

  it("reports concurrent calls as separate steps", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        investigateConversation: tool({
          description: "investigate",
          inputSchema: noInput,
          execute: async () => ({ status: "ok", highlights: [] }),
        }),
      },
      sink,
    );

    await Promise.all([
      wrapped.investigateConversation.execute!({}, {} as never),
      wrapped.investigateConversation.execute!({}, {} as never),
    ]);

    expect(events.map((event) => event.id)).toEqual(["1", "2"]);
    expect(events.every((event) => event.outcome === "ok")).toBe(true);
  });

  it("leaves a tool without execute alone", () => {
    const { sink } = recordingSink();
    const bare = { note: tool({ description: "no execute", inputSchema: noInput }) };
    const wrapped = withProgress(bare, sink);
    expect(wrapped.note).toBe(bare.note);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/reading-report/progress.test.ts`
Expected: FAIL —— 无法解析模块 `@main/reading-report/progress`。

- [ ] **Step 3: 实现装饰器**

新建 `src/main/reading-report/progress.ts`：

```ts
// src/main/reading-report/progress.ts —— 把工具调用变成用户可见的生成进度事件。
import type { ToolSet } from "ai";
import type { ReadingReportProgressOutcome } from "@shared/reading-sessions";
import type { ProgressSink } from "@main/reading-report/runtime";

/** 报告工具的输出统一是分页形状；从中抽出可展示的条目数，抽不到返回 null。 */
export function progressCount(output: unknown): number | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  for (const key of ["items", "messages"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/**
 * 只区分「成功」与「被跳过」。runTool 把异常吞成 { error }、investigateConversation
 * 把拿不到额度/调查失败降级成 busy/failed —— 这些都是既定降级路径，对用户显示为「已跳过」
 * 而非报错，免得让人以为整份报告废了。
 */
export function progressOutcome(output: unknown): ReadingReportProgressOutcome {
  if (typeof output !== "object" || output === null) return "ok";
  const record = output as Record<string, unknown>;
  if (typeof record.error === "string") return "skipped";
  if (record.status === "busy" || record.status === "failed") return "skipped";
  return "ok";
}

type AnyExecute = (input: never, options: never) => unknown;

/**
 * 在每个工具的 execute 入口/出口上报进度。刻意不用 generateText 的 onStepFinish：
 * 那只在步结束后触发，「正在读第 3 个会话」要等读完才显示，恰好错过需要反馈的那段时间。
 */
export function withProgress<T extends ToolSet>(tools: T, sink: ProgressSink): T {
  const entries = Object.entries(tools).map(([name, definition]) => {
    const execute = (definition as { execute?: AnyExecute }).execute;
    if (typeof execute !== "function") return [name, definition] as const;
    const wrapped = async (input: never, options: never) => {
      const id = sink.start(name);
      try {
        const output = await execute(input, options);
        sink.finish(id, progressOutcome(output), progressCount(output));
        return output;
      } catch (err) {
        sink.finish(id, "skipped", null);
        throw err;
      }
    };
    return [name, { ...definition, execute: wrapped }] as const;
  });
  return Object.fromEntries(entries) as T;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/main/reading-report/progress.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/reading-report/progress.ts src/main/reading-report/progress.test.ts
git commit -m "feat(report): add a tool set decorator that reports generation progress"
```

---

### Task 3: 接入 service

**Files:**

- Modify: `src/main/reading-report/service.ts:85-115`
- Test: `src/main/reading-report/service.test.ts`

**Interfaces:**

- Consumes: `withProgress`（Task 2）、`runtime.sink`（Task 1）
- Produces: 无新导出；`startReadingReportGeneration` 交给 `runAgent` 的 `tools` 自此已被 `withProgress` 包过。

- [ ] **Step 1: 写失败的测试**

在 `src/main/reading-report/service.test.ts` 的 `describe("reading report service", ...)` 内追加：

```ts
it("surfaces tool calls as generation progress", async () => {
  const { deps, session, task, drain } = setup();
  deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
  deps.runAgent = async (input) => {
    await input.tools.listAnnotations!.execute!({ offset: 0, limit: 50 }, {} as never);
    return task.promise;
  };

  startReadingReportGeneration(deps, session.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = getReadingSessionDetail(deps, session.id).report;
  expect(state.status).toEqual("generating");
  const steps = state.status === "generating" ? state.progress : [];
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ tool: "listAnnotations", outcome: "ok", count: 1 });

  task.resolve("# Done");
  await drain();
});
```

（`count` 为 1 因为 `setup()` 默认插入了一条标注。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/reading-report/service.test.ts -t "surfaces tool calls"`
Expected: FAIL —— `steps` 为空数组（工具未被包裹）。

- [ ] **Step 3: 接上装饰器**

编辑 `src/main/reading-report/service.ts`：

import 区加入（放在 `import { buildReadingReportSystemPrompt }` 之后，保持既有分组风格）：

```ts
import { withProgress } from "@main/reading-report/progress";
```

把第 104–113 行的 `deps.runAgent({...})` 调用中的 `tools` 一行：

```ts
      tools: { ...tools, ...memoryWorkspace.tools },
```

替换为：

```ts
      tools: withProgress(
        { ...tools, ...memoryWorkspace.tools },
        deps.runtime.sink(session.id, claim.generation),
      ),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/main/reading-report/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/reading-report/service.ts src/main/reading-report/service.test.ts
git commit -m "feat(report): wire tool progress into report generation"
```

---

### Task 4: 渲染层视图模型

**Files:**

- Modify: `src/renderer/reading/report-view-model.ts`
- Test: `src/renderer/reading/report-view-model.test.ts`

**Interfaces:**

- Consumes: `ReadingReportState`（Task 1 扩展后的形状）
- Produces: `ReportViewModel` 新增两个字段 —— `progress: ReadingReportProgressStep[]`（非生成/非失败态为 `[]`）与 `startedAt: number | null`（仅生成中非 null）

- [ ] **Step 1: 写失败的测试**

编辑 `src/renderer/reading/report-view-model.test.ts`，给 `it.each` 表里六条记录的**输入**与**期望**都补上新字段。整个 `it.each([...])` 块替换为：

```ts
it.each([
  [
    "empty",
    { status: "empty" },
    {
      content: null,
      busy: false,
      canGenerate: true,
      canEdit: true,
      canCancel: false,
      error: null,
      progress: [],
      startedAt: null,
    },
  ],
  [
    "generating",
    { status: "generating", startedAt: 1_000, progress: [] },
    {
      content: null,
      busy: true,
      canGenerate: false,
      canEdit: false,
      canCancel: true,
      error: null,
      progress: [],
      startedAt: 1_000,
    },
  ],
  [
    "generation-failed",
    { status: "generation-failed", progress: [step] },
    {
      content: null,
      busy: false,
      canGenerate: true,
      canEdit: true,
      canCancel: false,
      error: "generation-failed",
      progress: [step],
      startedAt: null,
    },
  ],
  [
    "ready",
    { status: "ready", content: "# Report" },
    {
      content: "# Report",
      busy: false,
      canGenerate: true,
      canEdit: true,
      canCancel: false,
      error: null,
      progress: [],
      startedAt: null,
    },
  ],
  [
    "regenerating",
    { status: "regenerating", content: "# Earlier report", startedAt: 2_000, progress: [step] },
    {
      content: "# Earlier report",
      busy: true,
      canGenerate: false,
      canEdit: false,
      canCancel: true,
      error: null,
      progress: [step],
      startedAt: 2_000,
    },
  ],
  [
    "regeneration-failed",
    { status: "regeneration-failed", content: "# Earlier report", progress: [step] },
    {
      content: "# Earlier report",
      busy: false,
      canGenerate: true,
      canEdit: true,
      canCancel: false,
      error: "regeneration-failed",
      progress: [step],
      startedAt: null,
    },
  ],
] as const)("projects %s state", (_status, state, expected) => {
  expect(reportViewModel(state)).toEqual(expected);
});
```

并在 `describe` 之前（import 之后）加上共用的样例条目：

```ts
const step = {
  id: "1",
  tool: "listAnnotations",
  startedAt: 1_000,
  endedAt: 2_000,
  outcome: "ok",
  count: 24,
} as const;
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/reading/report-view-model.test.ts`
Expected: FAIL —— 返回对象缺少 `progress` / `startedAt`。

- [ ] **Step 3: 扩展视图模型**

编辑 `src/renderer/reading/report-view-model.ts`：

import 改为：

```ts
import type { ReadingReportProgressStep, ReadingReportState } from "@shared/reading-sessions";
```

接口加两个字段：

```ts
export interface ReportViewModel {
  content: string | null;
  busy: boolean;
  canGenerate: boolean;
  canEdit: boolean;
  canCancel: boolean;
  error: "generation-failed" | "regeneration-failed" | null;
  /** 本次生成的工具活动时间线；非生成/非失败态为空。 */
  progress: readonly ReadingReportProgressStep[];
  /** 生成开始时刻（epoch ms），仅生成中非 null —— 渲染层据此自行计时。 */
  startedAt: number | null;
}
```

六个 `case` 的返回对象逐一补字段：

- `empty` / `ready`：加 `progress: [], startedAt: null`
- `generating`：加 `progress: state.progress, startedAt: state.startedAt`
- `regenerating`：加 `progress: state.progress, startedAt: state.startedAt`
- `generation-failed` / `regeneration-failed`：加 `progress: state.progress, startedAt: null`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/reading/report-view-model.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/reading/report-view-model.ts src/renderer/reading/report-view-model.test.ts
git commit -m "feat(report): expose generation progress through the report view model"
```

---

### Task 5: 时间线组件与文案

**Files:**

- Create: `src/renderer/reading/ReportProgressTimeline.tsx`
- Modify: `src/renderer/reading/ReadingReportView.tsx:283-291`
- Modify: `src/shared/i18n/locales/en.ts`
- Modify: `src/shared/i18n/locales/zh-CN.ts`
- Test: `src/shared/i18n/locales.test.ts`

**Interfaces:**

- Consumes: `ReportViewModel.progress` / `.startedAt`（Task 4）
- Produces: `<ReportProgressTimeline progress={...} startedAt={...} />`

- [ ] **Step 1: 写失败的 i18n 测试**

编辑 `src/shared/i18n/locales.test.ts`，在既有的 key 清单常量之后新增一个清单，并把它接进已有的覆盖率断言（照抄文件里 `task6ReadingKeys` 被使用的写法，加一个同形状的 `describe`/`it`）：

```ts
const reportProgressKeys = [
  "readingReport.progress.count",
  "readingReport.progress.elapsed",
  "readingReport.progress.skipped",
  "readingReport.progress.steps",
  "readingReport.progress.title",
  "readingReport.progress.tool.getBookSummary",
  "readingReport.progress.tool.getChapterSummary",
  "readingReport.progress.tool.getPreviousReadingReport",
  "readingReport.progress.tool.getSessionReadingStats",
  "readingReport.progress.tool.getToc",
  "readingReport.progress.tool.investigateConversation",
  "readingReport.progress.tool.listAnnotations",
  "readingReport.progress.tool.listBookNotes",
  "readingReport.progress.tool.listConversations",
  "readingReport.progress.tool.listPreviousReadingSessions",
  "readingReport.progress.tool.readChapterText",
  "readingReport.progress.tool.readConversation",
  "readingReport.progress.tool.readMemory",
  "readingReport.progress.tool.readPage",
  "readingReport.progress.tool.saveMemory",
  "readingReport.progress.tool.unknown",
  "readingReport.progress.tool.updateMemory",
] as const;

describe("reading report progress copy", () => {
  it.each(reportProgressKeys)("defines %s in both locales", (key) => {
    expect(en[key]).toBeTruthy();
    expect(zhCN[key]).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/shared/i18n/locales.test.ts`
Expected: FAIL —— 每个新 key 都 undefined。

- [ ] **Step 3: 补上两个语言的文案**

`src/shared/i18n/locales/en.ts`，按字母序插到 `"readingReport.generating"` 与 `"readingReport.generationStopped"` 之间（`progress.*` 排在 `generationStopped` 之后、`insufficientEvidence` 之前，按实际字母序放好）：

```ts
  "readingReport.progress.count_one": "{{count}} item",
  "readingReport.progress.count_other": "{{count}} items",
  "readingReport.progress.count": "{{count}} items",
  "readingReport.progress.elapsed": "{{elapsed}} elapsed",
  "readingReport.progress.skipped": "skipped",
  "readingReport.progress.steps_one": "{{count}} step done",
  "readingReport.progress.steps_other": "{{count}} steps done",
  "readingReport.progress.steps": "{{count}} steps done",
  "readingReport.progress.title": "Generating report",
  "readingReport.progress.tool.getBookSummary": "Checking the whole-book summary",
  "readingReport.progress.tool.getChapterSummary": "Checking a chapter summary",
  "readingReport.progress.tool.getPreviousReadingReport": "Reading an earlier report",
  "readingReport.progress.tool.getSessionReadingStats": "Checking reading time",
  "readingReport.progress.tool.getToc": "Looking at the table of contents",
  "readingReport.progress.tool.investigateConversation": "Sending an assistant into a long conversation",
  "readingReport.progress.tool.listAnnotations": "Collecting this reading's annotations",
  "readingReport.progress.tool.listBookNotes": "Collecting this reading's notes",
  "readingReport.progress.tool.listConversations": "Listing this reading's conversations",
  "readingReport.progress.tool.listPreviousReadingSessions": "Looking up earlier readings",
  "readingReport.progress.tool.readChapterText": "Rereading the text",
  "readingReport.progress.tool.readConversation": "Reading a conversation",
  "readingReport.progress.tool.readMemory": "Reading memory",
  "readingReport.progress.tool.readPage": "Rereading a page",
  "readingReport.progress.tool.saveMemory": "Saving a memory",
  "readingReport.progress.tool.unknown": "Working",
  "readingReport.progress.tool.updateMemory": "Updating a memory",
```

`src/shared/i18n/locales/zh-CN.ts` 对应位置：

```ts
  "readingReport.progress.count": "{{count}} 条",
  "readingReport.progress.elapsed": "已用 {{elapsed}}",
  "readingReport.progress.skipped": "已跳过",
  "readingReport.progress.steps": "已完成 {{count}} 步",
  "readingReport.progress.title": "正在生成报告",
  "readingReport.progress.tool.getBookSummary": "查看全书摘要",
  "readingReport.progress.tool.getChapterSummary": "查看章节摘要",
  "readingReport.progress.tool.getPreviousReadingReport": "翻阅过往报告",
  "readingReport.progress.tool.getSessionReadingStats": "统计阅读时长",
  "readingReport.progress.tool.getToc": "查看目录",
  "readingReport.progress.tool.investigateConversation": "派调查员深读长会话",
  "readingReport.progress.tool.listAnnotations": "清点本次标注",
  "readingReport.progress.tool.listBookNotes": "清点本次笔记",
  "readingReport.progress.tool.listConversations": "列出本次会话",
  "readingReport.progress.tool.listPreviousReadingSessions": "查找过往阅读",
  "readingReport.progress.tool.readChapterText": "回读原文",
  "readingReport.progress.tool.readConversation": "读会话内容",
  "readingReport.progress.tool.readMemory": "读取记忆",
  "readingReport.progress.tool.readPage": "回读书页",
  "readingReport.progress.tool.saveMemory": "写下一条记忆",
  "readingReport.progress.tool.unknown": "处理中",
  "readingReport.progress.tool.updateMemory": "更新一条记忆",
```

英文的 `_one` / `_other` 复数变体按 i18next 约定保留；中文无复数变体。若 `pnpm i18n:lint` 对基础 key 与复数 key 并存报警，删掉不带后缀的 `count` / `steps` 基础 key，并把测试清单里对应两项换成 `_other` 后缀版本。

Run: `pnpm test src/shared/i18n/locales.test.ts`
Expected: PASS

- [ ] **Step 4: 写时间线组件**

新建 `src/renderer/reading/ReportProgressTimeline.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Check, Loader2, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReadingReportProgressStep } from "@shared/reading-sessions";

/** 每秒滴答一次，让进行中的条目自己走秒——主进程不推秒数。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatSeconds(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function ReportProgressTimeline({
  progress,
  startedAt,
}: {
  progress: readonly ReadingReportProgressStep[];
  startedAt: number | null;
}) {
  const { t } = useTranslation();
  const now = useNow(startedAt != null);
  if (progress.length === 0 && startedAt == null) return null;

  const done = progress.filter((step) => step.endedAt != null).length;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {startedAt != null ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            <span className="text-foreground">{t("readingReport.progress.title")}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {t("readingReport.progress.elapsed", { elapsed: formatSeconds(now - startedAt) })}
            </span>
          </>
        ) : null}
        {progress.length > 0 ? (
          <>
            {startedAt != null ? <span aria-hidden>·</span> : null}
            <span className="tabular-nums">
              {t("readingReport.progress.steps", { count: done })}
            </span>
          </>
        ) : null}
      </div>

      <ol className="flex max-h-56 flex-col gap-1.5 overflow-y-auto text-sm">
        {progress.map((step) => (
          <TimelineRow key={step.id} step={step} now={now} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ step, now }: { step: ReadingReportProgressStep; now: number }) {
  const { t } = useTranslation();
  const running = step.endedAt == null;
  const skipped = step.outcome === "skipped";
  const label = t([
    `readingReport.progress.tool.${step.tool}`,
    "readingReport.progress.tool.unknown",
  ]);

  return (
    <li className="flex items-baseline gap-2">
      <span className="relative top-0.5 shrink-0 text-muted-foreground">
        {running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : skipped ? (
          <Minus className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </span>
      <span className={running ? "text-foreground" : "text-muted-foreground"}>{label}</span>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
        {running
          ? formatSeconds(now - step.startedAt)
          : skipped
            ? t("readingReport.progress.skipped")
            : step.count != null
              ? t("readingReport.progress.count", { count: step.count })
              : null}
      </span>
    </li>
  );
}
```

`useNow` 里用 `Date.now()` 而非 Temporal：这是渲染层每秒滴答的墙钟读数，`Temporal.Now.instant().epochMilliseconds` 每次都要构造一个对象，此处只要毫秒数；仓库的 Temporal 规约针对的是日期时间**运算与投影**，这里没有任何日期运算。若审查坚持统一，可换成 `Temporal.Now.instant().epochMilliseconds`，行为一致。

自动滚到底刻意不做：`max-h-56` + `overflow-y-auto` 已能让用户手动查看，强制滚动会打断正在往回看的用户。

- [ ] **Step 5: 接进报告卡片**

编辑 `src/renderer/reading/ReadingReportView.tsx`。

import 区加入：

```tsx
import { ReportProgressTimeline } from "./ReportProgressTimeline";
```

把 `CardContent` 里第 283–291 行这段：

```tsx
              ) : model.content ? (
                <LocalizedStreamdown className="font-serif leading-8">
                  {model.content}
                </LocalizedStreamdown>
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                  {model.busy ? t("readingReport.generating") : t("readingReport.empty")}
                </div>
              )}
```

替换为：

```tsx
              ) : (
                <>
                  <ReportProgressTimeline
                    progress={model.progress}
                    startedAt={model.startedAt}
                  />
                  {model.content ? (
                    <LocalizedStreamdown className="font-serif leading-8">
                      {model.content}
                    </LocalizedStreamdown>
                  ) : model.progress.length === 0 && !model.busy ? (
                    <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                      {t("readingReport.empty")}
                    </div>
                  ) : null}
                </>
              )}
```

这样：生成中显示时间线（尚无正文）；重新生成时时间线在上、旧正文在下；失败时时间线保留在错误提示下方；`empty` 态仍显示原来那句空文案。`readingReport.generating` 这条旧文案不再被引用，但保留在 locales 里——下一阶段正文流式时还要用。

- [ ] **Step 6: 全量验证**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm i18n:lint
```

Expected: 全绿。若 `pnpm i18n:extract` 报出未使用/缺失的 key，按 Step 3 末尾的说明调整复数 key 形态后重跑。

- [ ] **Step 7: 手动冒烟**

Run: `pnpm dev`，打开一本已完成阅读的书 → 阅读报告 → 点「生成报告」。

Expected: 卡片内出现时间线，条目随 agent 推进逐条追加，进行中的条目转圈并自增秒数，多个 `investigateConversation` 并列显示；报告出来后时间线消失、只剩正文。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/reading/ReportProgressTimeline.tsx src/renderer/reading/ReadingReportView.tsx src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales.test.ts
git commit -m "feat(report): show a live activity timeline while a report generates"
```

- [ ] **Step 9: 写 changeset**

```bash
pnpm changeset
```

条目内容（英文，用户向）：

> Reading report generation now shows a live activity timeline — what the assistant is inspecting, how long it has been running, and which steps were skipped — instead of a single static message.
