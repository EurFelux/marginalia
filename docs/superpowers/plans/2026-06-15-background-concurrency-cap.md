# 后台模型调用全局并发上限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给所有后台模型调用（章节/全书摘要、会话命名、上下文压缩）加一个可配置的全局并发上限（默认 3，FIFO 排队），前台聊天回复永不入限流器。

**Architecture:** 新建纯 `Limiter` 类（`run(fn)` 排队/放行，`getLimit()` 实时读 preference），进程单例在 `send-deps.ts` 装配并作为 `runBackground` 注入三个 deps 接口；各后台调用点用它包住「加载 + 模型调用」，同步 claim `inFlight` 前缀留槽外。Settings「高级」面板加数字控件（仿 `stepLimit`）。

**Tech Stack:** TypeScript / Zod 4 / Vercel AI SDK v6 / Drizzle / Zustand / React 19 / vitest 4（无头，Electron 运行时）/ i18next。

**设计文档：** `docs/superpowers/specs/2026-06-15-background-concurrency-cap-design.md`

---

## Task 1: 注册 `backgroundConcurrency` preference（shared schema + handler case）

新增 preference key（shared 单一源）并补 `preferences:set` 穷尽性 case，使 typecheck 与 schema 测试保持绿。

**Files:**

- Modify: `src/shared/preferences.ts`
- Modify: `src/main/ipc/preferences-handlers.ts`
- Test: `src/shared/preferences.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/shared/preferences.test.ts` 的 `"registers exactly the keys with current consumers"` 测试里，把期望的 key 数组**加入** `"backgroundConcurrency"`（保持字母序，排在 `"autoSummarize"` 之后）：

```ts
expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
  "autoSummarize",
  "backgroundConcurrency",
  "chatModel",
  "colorMode",
  "instructions",
  "language",
  "lastHighlightStyle",
  "memoryEnabled",
  "onboardingDismissed",
  "pdfZoom",
  "readerLayout",
  "readerPrefs",
  "soul",
  "stepLimit",
  "summaryModel",
  "ttsPrefs",
]);
```

并在文件末尾（`stepLimit preference` describe 之后）新增一个 describe：

```ts
describe("backgroundConcurrency preference", () => {
  it("accepts positive ints, rejects 0/negatives/floats/strings", () => {
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: 3 }).success).toBe(
      true,
    );
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: 1 }).success).toBe(
      true,
    );
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: 0 }).success).toBe(
      false,
    );
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: -1 }).success).toBe(
      false,
    );
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: 2.5 }).success).toBe(
      false,
    );
    expect(setPreferenceInput.safeParse({ key: "backgroundConcurrency", value: "3" }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/shared/preferences.test.ts`
Expected: FAIL（`registers exactly the keys` 数组不匹配；新 describe 因 key 未注册而全 false→部分断言失败）

- [ ] **Step 3: 实现 schema + 注册 + setPreferenceInput arm**

在 `src/shared/preferences.ts` 中，紧接 `stepLimitSchema` / `DEFAULT_STEP_LIMIT` 那段之后新增：

```ts
/** 后台模型调用（章节/全书摘要 + 会话命名 + 上下文压缩）的全局并发上限。正整数；无「不限制」档（0=摘要永不跑＝坑）。 */
export const backgroundConcurrencySchema = z.number().int().positive();

/** backgroundConcurrency 缺省值：主进程兜底与渲染层初值共用单一源。 */
export const DEFAULT_BACKGROUND_CONCURRENCY = 3;
```

在 `PREFERENCE_SCHEMAS` 对象里加一行（紧跟 `stepLimit`）：

```ts
  stepLimit: stepLimitSchema,
  backgroundConcurrency: backgroundConcurrencySchema,
```

在 `setPreferenceInput` 判别联合里加一条 arm（紧跟 stepLimit arm）：

```ts
  z.object({ key: z.literal("stepLimit"), value: stepLimitSchema }),
  z.object({ key: z.literal("backgroundConcurrency"), value: backgroundConcurrencySchema }),
```

- [ ] **Step 4: 补 `preferences:set` handler 穷尽性 case**

在 `src/main/ipc/preferences-handlers.ts` 的 switch 里，紧跟 `case "stepLimit":` 之后加：

```ts
      case "backgroundConcurrency":
        return setPreference(getDb(), input.key, input.value);
```

- [ ] **Step 5: 运行测试 + typecheck 确认通过**

Run: `pnpm test src/shared/preferences.test.ts && pnpm typecheck`
Expected: PASS（schema 测试全绿；typecheck 无 `never` 守卫报错）

- [ ] **Step 6: Commit**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts src/main/ipc/preferences-handlers.ts
git commit -m "feat(preferences): register backgroundConcurrency preference"
```

---

## Task 2: 纯 `Limiter` 类

进程级并发限流原语，纯类、无 Electron/DB 依赖，独立单测。

**Files:**

- Create: `src/main/ai/background-limiter.ts`
- Test: `src/main/ai/background-limiter.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/ai/background-limiter.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { Limiter } from "@main/ai/background-limiter";

/** 可手动 resolve 的 deferred，用于精确控制任务完成时机。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Limiter", () => {
  it("runs immediately when below the limit and returns the result", async () => {
    const limiter = new Limiter(() => 2);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  it("never exceeds the concurrency limit", async () => {
    const limiter = new Limiter(() => 2);
    let active = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = gates.map((g) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
      }),
    );
    await Promise.resolve(); // 让已放行的任务推进到 await
    expect(active).toBe(2); // 仅 2 个在跑，其余排队
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("releases a queued task in FIFO order when a slot frees", async () => {
    const limiter = new Limiter(() => 1);
    const order: number[] = [];
    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const g3 = deferred<void>();
    const r1 = limiter.run(async () => {
      order.push(1);
      await g1.promise;
    });
    const r2 = limiter.run(async () => {
      order.push(2);
      await g2.promise;
    });
    const r3 = limiter.run(async () => {
      order.push(3);
      await g3.promise;
    });
    await Promise.resolve();
    expect(order).toEqual([1]); // 只有第一个启动
    g1.resolve();
    await r1;
    expect(order).toEqual([1, 2]); // 第二个（最先入队）接棒
    g2.resolve();
    await r2;
    expect(order).toEqual([1, 2, 3]);
    g3.resolve();
    await r3;
  });

  it("propagates rejection without wedging the queue", async () => {
    const limiter = new Limiter(() => 1);
    const g2 = deferred<void>();
    const r1 = limiter.run(async () => {
      throw new Error("boom");
    });
    let secondRan = false;
    const r2 = limiter.run(async () => {
      secondRan = true;
      await g2.promise;
    });
    await expect(r1).rejects.toThrow("boom");
    await Promise.resolve();
    expect(secondRan).toBe(true); // 失败释放空位，队列继续
    g2.resolve();
    await r2;
  });

  it("honors a raised limit on the next pump", async () => {
    let limit = 1;
    const limiter = new Limiter(() => limit);
    const g1 = deferred<void>();
    let started = 0;
    const r1 = limiter.run(async () => {
      started++;
      await g1.promise;
    });
    limiter.run(async () => {
      started++;
      await new Promise(() => {});
    });
    await Promise.resolve();
    expect(started).toBe(1);
    limit = 2; // 调大
    g1.resolve();
    await r1; // settle 触发 pump，按新上限放行第二个
    await Promise.resolve();
    expect(started).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/ai/background-limiter.test.ts`
Expected: FAIL（`Cannot find module '@main/ai/background-limiter'`）

- [ ] **Step 3: 实现 Limiter**

创建 `src/main/ai/background-limiter.ts`：

```ts
// src/main/ai/background-limiter.ts

/** 包后台任务执行的注入端口：受全局并发上限约束地跑 fn，返回其结果（或透传其 reject）。 */
export type RunBackground = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * 全局并发限流器：同时放行的任务数不超过 getLimit() 返回值，超出的排队（FIFO），有空位再放行。
 * 纯类，无 Electron/DB 依赖，可独立单测。getLimit 每次放行时实时读取——调小立即对「新启动」生效，
 * 调大在下一次 run/settle 触发 pump 时生效（绝不杀正在跑的任务）。
 */
export class Limiter {
  constructor(private readonly getLimit: () => number) {}

  private active = 0;
  private readonly queue: Array<() => void> = [];

  run: RunBackground = (fn) =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      };
      if (this.active < this.getLimit()) attempt();
      else this.queue.push(attempt);
    });

  private pump(): void {
    while (this.queue.length > 0 && this.active < this.getLimit()) this.queue.shift()!();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/main/ai/background-limiter.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/background-limiter.ts src/main/ai/background-limiter.test.ts
git commit -m "feat(ai): add Limiter concurrency primitive"
```

---

## Task 3: 章节/全书摘要接入限流器（SummaryDeps + 单例装配）

`SummaryDeps` 加必填 `runBackground`，两个 ensure 函数把「加载 + 模型调用」包进槽；在 `send-deps.ts` 装配进程单例并注入 `makeSummaryDeps`。

**Files:**

- Modify: `src/main/ai/summary.ts`
- Modify: `src/main/ai/send-deps.ts`
- Test: `src/main/ai/summary.test.ts`

- [ ] **Step 1: 写失败测试（cap 真生效 + 现有 deps 补字段）**

在 `src/main/ai/summary.test.ts` 顶部 import 区加入 `Limiter`：

```ts
import { Limiter } from "@main/ai/background-limiter";
import type { RunBackground } from "@main/ai/background-limiter";
```

把 line 74 的 deps 字面量补上 pass-through `runBackground`（让既有用例继续编译/通过）：

```ts
const passThrough: RunBackground = (fn) => fn();
const deps: SummaryDeps = { db, loadBytes, resolveModel: () => model, runBackground: passThrough };
```

> 注：`setup()` 返回的 `deps` 是该字面量。若 `setup()` 接受可选覆盖参数，照搬即可；否则直接改这一行。

在文件末尾新增一个 describe，断言 cap=1 时第二个章节摘要被推迟：

```ts
describe("ensureChapterSummary respects the background limiter", () => {
  it("defers the second chapter's model call until the first finishes (cap=1)", async () => {
    const { db, book, deps: baseDeps } = await setup({ ok: true });
    // 两章
    const chA = book.chapters[0]!.id;
    const chB = book.chapters[1]!.id;

    // 受控 model：doGenerate 在外部 resolve 前不返回
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => {
      releaseFirst = res;
    });
    let calls = 0;
    const order: string[] = [];
    const controlledModel = makeChapterModel(async () => {
      calls++;
      const idx = calls;
      order.push(`start${idx}`);
      if (idx === 1) await gate;
      return "summary text";
    });

    const deps: SummaryDeps = {
      ...baseDeps,
      resolveModel: () => ({ ok: true, model: controlledModel, modelId: "m" }),
      runBackground: new Limiter(() => 1).run,
    };

    const p1 = ensureChapterSummary(deps, book.id, chA);
    const p2 = ensureChapterSummary(deps, book.id, chB);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start1"]); // 第二个仍在排队
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start1", "start2"]);
  });
});
```

> 实现者注：`makeChapterModel(handler)` 需复用 `summary.test.ts` 既有的 mock model 构造方式（仿现有 `model` fixture 的 `doGenerate`，把返回文本改为调 `handler()`）。若现有 fixture 名称/构造不同，按文件实际写法对齐——关键是 doGenerate 走受控 gate。`setup()` 需能拿到第二章 id（fixture 已有多章则取 `book.chapters[1]`；若只有一章，扩展 fixture 或改用 book summary 做此断言）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/ai/summary.test.ts`
Expected: FAIL（`SummaryDeps` 尚无 `runBackground` 字段 → 类型错误；新用例因未包限流器而 `order` 立即为两项）

- [ ] **Step 3: 实现 SummaryDeps 字段 + 包裹**

在 `src/main/ai/summary.ts`：import 区加 `import type { RunBackground } from "@main/ai/background-limiter";`，`SummaryDeps` 接口加字段：

```ts
export interface SummaryDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  /** 后台并发限流端口：包住「加载 + 模型调用」，受全局上限约束。 */
  runBackground: RunBackground;
}
```

`ensureChapterSummary`：把 `loadBytes`+`readChapterText`+`generateText` 包进 `runBackground`（claim `inFlight` 前缀保持在槽外）。将原 105–115 行替换为：

```ts
const text = await deps.runBackground(async () => {
  const bytes = await loadBytes(bookId);
  const slice = await readChapterText(db, bytes, bookId, chapterId, {
    maxChars: SUMMARY_INPUT_MAX_CHARS,
  });
  const generated = await generateText({
    model: resolved.model,
    system: SUMMARY_SYSTEM,
    prompt: slice.text,
    maxOutputTokens: 512,
    maxRetries: 1,
  });
  return generated.text;
});
```

（其后的 `if (!hasText(text)) {...}` 与 `db.update(...)` 落库保持原样、留在槽外。）

`ensureBookSummary`：把 `loadBytes`+`readBookText`+`streamText` 循环包进 `runBackground`，返回累积文本与错误标志。将原 195–216 行替换为：

```ts
const produced = await deps.runBackground(async () => {
  const bytes = await loadBytes(bookId);
  const { text } = await readBookText(db, bytes, bookId, {
    maxChars: BOOK_SUMMARY_INPUT_MAX_CHARS,
  });
  // streamText 遇错发 error chunk 并正常关流（textStream 不 throw），故用 onError 标志兜——否则会把半截落库。
  let hadError = false;
  const result = streamText({
    model: resolved.model,
    system: BOOK_SUMMARY_SYSTEM,
    prompt: text,
    maxOutputTokens: 4096, // 全书摘要（主题/人物/结构、多段）比单章长，给足额度避免输出截断
    maxRetries: 1,
    onError: ({ error }) => {
      hadError = true;
      log.warn(`book ${bookId} stream error`, error);
    },
  });
  let acc = "";
  for await (const delta of result.textStream) {
    acc += delta;
    streamingBookSummaries.set(bookId, acc); // partial 供 getBookSummaryView 轮询读取
  }
  return { acc, hadError };
});
if (produced.hadError || !hasText(produced.acc)) {
  // 流错误或空产出（provider 不报错但 0 字符）均不落库（保留旧 summary 不变），标 failed 可重试
  if (!produced.hadError) log.warn(`book ${bookId} generated empty text, treated as failure`);
  failedBooks.add(bookId);
} else db.update(books).set({ summary: produced.acc }).where(eq(books.id, bookId)).run();
```

- [ ] **Step 4: 装配进程单例 + 注入 makeSummaryDeps**

在 `src/main/ai/send-deps.ts`：import 区加：

```ts
import { Limiter } from "@main/ai/background-limiter";
import { getPreference } from "@main/preferences/repository";
import { DEFAULT_STEP_LIMIT, DEFAULT_BACKGROUND_CONCURRENCY } from "@shared/preferences";
```

（`getPreference` 已 import，则只补 `DEFAULT_BACKGROUND_CONCURRENCY` 与 `Limiter`。）模块级新增单例（在函数定义之前）：

```ts
/** 进程级后台并发限流器。getLimit 惰性实时读 preference——改设置即时生效，模块加载期不碰 getDb。 */
const backgroundLimiter = new Limiter(
  () => getPreference(getDb(), "backgroundConcurrency") ?? DEFAULT_BACKGROUND_CONCURRENCY,
);
```

`makeSummaryDeps()` 返回对象补 `runBackground: backgroundLimiter.run`：

```ts
export function makeSummaryDeps(): SummaryDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(appService.getPath("booksDir"), db),
    resolveModel: () => resolveSummaryModel(db),
    runBackground: backgroundLimiter.run,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test src/main/ai/summary.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/summary.ts src/main/ai/send-deps.ts src/main/ai/summary.test.ts
git commit -m "feat(ai): cap chapter/book summary model calls via limiter"
```

---

## Task 4: 命名 / 压缩接入限流器（SendDeps + NamingDeps + CompactionDeps）

`SendDeps` 加 `runBackground`，`makeSendDeps` 注入单例，`stream-assistant` 透传给命名/压缩；两个调用点把 `generateText` 包进槽。

**Files:**

- Modify: `src/main/ai/send.ts`
- Modify: `src/main/ai/send-deps.ts`
- Modify: `src/main/ai/stream-assistant.ts`
- Modify: `src/main/chat/conversation-title.ts`
- Modify: `src/main/ai/context-compaction.ts`
- Test: `src/main/chat/conversation-title.test.ts`
- Test: `src/main/ai/context-compaction.test.ts`
- Test: `src/main/ai/send.test.ts`

- [ ] **Step 1: 写失败测试（cap 生效 + 现有 deps 补字段）**

在 `src/main/chat/conversation-title.test.ts`：import 区加 `import type { RunBackground } from "@main/ai/background-limiter";`，文件顶部加 `const passThrough: RunBackground = (fn) => fn();`，把每处 `nameConversation({ db, resolveModel: ... }, ...)` 的 deps 补 `runBackground: passThrough`，例如：

```ts
await nameConversation(
  {
    db,
    resolveModel: () => ({ ok: true, model: namingModel("雾的象征"), modelId: "m" }),
    runBackground: passThrough,
  },
  conversationId,
  userText,
  assistantText,
);
```

同样在 `src/main/ai/context-compaction.test.ts`：import `RunBackground`，加 `const passThrough: RunBackground = (fn) => fn();`，把每处 `maybeCompactConversation({ db, resolveModel: ... }, ...)` 补 `runBackground: passThrough`。

在 `src/main/ai/send.test.ts`：import `RunBackground`，在两处 `const deps: SendDeps = {...}`（line 102、483）与 `makeDeps()`（line 122）返回对象各补 `runBackground: (fn) => fn()`。

在 `context-compaction.test.ts` 末尾新增 cap 断言：

```ts
import { Limiter } from "@main/ai/background-limiter";

describe("maybeCompactConversation respects the background limiter", () => {
  it("serializes compaction model calls under cap=1", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const limiter = new Limiter(() => 1);
    // 复用本文件既有的 summaryModel(...) fixture + seed 两个超阈值会话的辅助；
    // 关键：两个 maybeCompactConversation 并发，断言第二个 generateText 被推迟。
    const modelA = summaryModelGated(async () => {
      order.push("startA");
      await gate;
      return "A";
    });
    const modelB = summaryModelGated(async () => {
      order.push("startB");
      return "B";
    });
    const pA = maybeCompactConversation(
      { db: dbA, resolveModel: () => modelA, runBackground: limiter.run },
      convA,
      FORCE,
    );
    const pB = maybeCompactConversation(
      { db: dbB, resolveModel: () => modelB, runBackground: limiter.run },
      convB,
      FORCE,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["startA"]);
    releaseFirst();
    await Promise.all([pA, pB]);
    expect(order).toEqual(["startA", "startB"]);
  });
});
```

> 实现者注：`summaryModelGated(handler)` 仿本文件既有 `summaryModel(text)` fixture，但 doGenerate 调 `handler()` 取文本（受控 gate）。`dbA/dbB/convA/convB` 用本文件既有的「seed 一个尾轮超阈值的会话」辅助各建一个（两库或两会话均可，只要 `planFold` 会触发）。若既有辅助只支持单会话，复用它建两次。`FORCE` 沿用本文件已有的小阈值 budget 常量。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/chat/conversation-title.test.ts src/main/ai/context-compaction.test.ts`
Expected: FAIL（`NamingDeps`/`CompactionDeps` 无 `runBackground` 字段 → 类型错误）

- [ ] **Step 3: 实现 NamingDeps / CompactionDeps 字段 + 包裹**

`src/main/chat/conversation-title.ts`：import `import type { RunBackground } from "@main/ai/background-limiter";`，`NamingDeps` 加字段：

```ts
export interface NamingDeps {
  db: DB;
  resolveModel: () => ResolvedModel;
  /** 后台并发限流端口（与摘要/压缩共用全局上限）。 */
  runBackground: RunBackground;
}
```

把 `nameConversation` 里的 `generateText` 调用（原 75–79 行）替换为：

```ts
const { text } = await deps.runBackground(() =>
  generateText({
    model: resolved.model,
    system: NAMING_SYSTEM,
    prompt: `用户：${userText}\n\n助手：${assistantText}`,
  }),
);
```

`src/main/ai/context-compaction.ts`：import `RunBackground`，`CompactionDeps` 加字段：

```ts
export interface CompactionDeps {
  db: DB;
  /** 摘要模型解析器（与章节/全书摘要、自动命名同源 resolveSummaryModel）。 */
  resolveModel: () => ResolvedModel;
  /** 后台并发限流端口（与摘要/命名共用全局上限）。 */
  runBackground: RunBackground;
}
```

把 `maybeCompactConversation` 里的 `generateText`（原 143–149 行）替换为：

```ts
const { text } = await deps.runBackground(() =>
  generateText({
    model: resolved.model,
    system: COMPACTION_SYSTEM,
    prompt: `${prior}New exchanges:\n${transcript}`,
    maxOutputTokens: SUMMARY_MAX_TOKENS,
    maxRetries: 1,
  }),
);
```

- [ ] **Step 4: SendDeps 字段 + makeSendDeps 注入 + stream-assistant 透传**

`src/main/ai/send.ts`：import `import type { RunBackground } from "@main/ai/background-limiter";`，`SendDeps` 接口加字段（紧跟 `resolveSummaryModel`）：

```ts
/** 后台并发限流端口：透传给 auto-naming / 压缩；摘要在 makeSummaryDeps 注入同一单例。 */
runBackground: RunBackground;
```

`src/main/ai/send-deps.ts` 的 `makeSendDeps()` 返回对象补 `runBackground: backgroundLimiter.run`：

```ts
return {
  db,
  loadBytes,
  resolveModel,
  resolveSummaryModel: () => resolveSummaryModel(db),
  stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT,
  runBackground: backgroundLimiter.run,
};
```

`src/main/ai/stream-assistant.ts`：line 55 的解构加 `runBackground`：

```ts
const { db, loadBytes, resolveSummaryModel, stepLimit, runBackground } = deps;
```

把两处后台调用补上 `runBackground`（line 139、146）：

```ts
          void nameConversation(
            { db, resolveModel: resolveSummaryModel, runBackground },
            conversationId,
            ctx.userText,
            assistantText,
          );
        }
        void maybeCompactConversation(
          { db, resolveModel: resolveSummaryModel, runBackground },
          conversationId,
        );
```

> 注：若 lint 报 `runBackground` 在解构后未直接使用（其实用于两处对象字面量），无需处理——它确有使用。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test src/main/chat/conversation-title.test.ts src/main/ai/context-compaction.test.ts src/main/ai/send.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/send.ts src/main/ai/send-deps.ts src/main/ai/stream-assistant.ts src/main/chat/conversation-title.ts src/main/ai/context-compaction.ts src/main/chat/conversation-title.test.ts src/main/ai/context-compaction.test.ts src/main/ai/send.test.ts
git commit -m "feat(ai): cap auto-naming and context compaction via limiter"
```

---

## Task 5: 渲染层状态 + clamp（prefs-store / hydrate / settings-logic）

把新 preference 接入渲染层 store 与启动 hydrate，加 UI 取值收敛函数。

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`
- Modify: `src/renderer/settings/settings-logic.ts`
- Test: `src/renderer/store/prefs-store.test.ts`
- Test: `src/renderer/settings/settings-logic.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/settings/settings-logic.test.ts`：import 区把 `clampBackgroundConcurrency` 加入从 `@renderer/settings/settings-logic` 的导入，并补 `DEFAULT_BACKGROUND_CONCURRENCY` 从 `@shared/preferences` 的导入；新增 describe：

```ts
describe("clampBackgroundConcurrency", () => {
  it("clamps to [1,10], truncates floats, falls back on non-finite", () => {
    expect(clampBackgroundConcurrency(3)).toBe(3);
    expect(clampBackgroundConcurrency(0)).toBe(1);
    expect(clampBackgroundConcurrency(11)).toBe(10);
    expect(clampBackgroundConcurrency(2.7)).toBe(2);
    expect(clampBackgroundConcurrency(NaN)).toBe(DEFAULT_BACKGROUND_CONCURRENCY);
  });
});
```

`src/renderer/store/prefs-store.test.ts`：import 区补 `DEFAULT_BACKGROUND_CONCURRENCY`，新增用例：

```ts
it("setBackgroundConcurrency updates value and persists", () => {
  usePrefsStore.getState().setBackgroundConcurrency(5);
  expect(usePrefsStore.getState().backgroundConcurrency).toBe(5);
  expect(persistPreference).toHaveBeenCalledWith({ key: "backgroundConcurrency", value: 5 });
});
it("backgroundConcurrency defaults to DEFAULT_BACKGROUND_CONCURRENCY", () => {
  expect(PREFS_INITIAL.backgroundConcurrency).toBe(DEFAULT_BACKGROUND_CONCURRENCY);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts src/renderer/store/prefs-store.test.ts`
Expected: FAIL（`clampBackgroundConcurrency`/`setBackgroundConcurrency` 未定义）

- [ ] **Step 3: 实现 clamp + store 字段/action + hydrate**

`src/renderer/settings/settings-logic.ts`：import 区把 `DEFAULT_BACKGROUND_CONCURRENCY` 加入从 `@shared/preferences` 的导入；在 `clampStepLimit` 之后新增：

```ts
/** 数字输入框的 backgroundConcurrency 取值收敛到 [1, 10] 整数；非有限值（空输入/NaN）回退默认。 */
export function clampBackgroundConcurrency(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_BACKGROUND_CONCURRENCY;
  return Math.min(10, Math.max(1, Math.trunc(raw)));
}
```

`src/renderer/store/prefs-store.ts`：import 区把 `DEFAULT_BACKGROUND_CONCURRENCY` 加入从 `@shared/preferences` 的导入。`PrefsState` 加字段（紧跟 `stepLimit`）：

```ts
/** 后台模型调用全局并发上限（章节/全书摘要 + 命名 + 压缩）；前台对话不受限。落盘记忆。 */
backgroundConcurrency: number;
```

`PrefsActions` 加：

```ts
  setBackgroundConcurrency: (v: number) => void;
```

`PREFS_INITIAL` 加（紧跟 `stepLimit`）：

```ts
  backgroundConcurrency: DEFAULT_BACKGROUND_CONCURRENCY,
```

store 实现里加 action（紧跟 `setStepLimit`）：

```ts
  setBackgroundConcurrency: (backgroundConcurrency) => {
    persistPreference({ key: "backgroundConcurrency", value: backgroundConcurrency });
    set({ backgroundConcurrency });
  },
```

`src/renderer/store/hydrate-preferences.ts`：紧跟 stepLimit 那行加：

```ts
if (snap.backgroundConcurrency !== undefined) {
  usePrefsStore.setState({ backgroundConcurrency: snap.backgroundConcurrency });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/settings/settings-logic.test.ts src/renderer/store/prefs-store.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts src/renderer/settings/settings-logic.ts src/renderer/store/prefs-store.test.ts src/renderer/settings/settings-logic.test.ts
git commit -m "feat(settings): wire backgroundConcurrency into renderer store"
```

---

## Task 6: Settings「高级」面板数字控件 + i18n

在 `AdvancedSettings` 加数字输入控件，加 i18n 文案并抽取。

**Files:**

- Modify: `src/renderer/settings/AdvancedSettings.tsx`
- Modify（自动生成）：`src/shared/i18n/locales/*`（经 `pnpm i18n:extract`）

- [ ] **Step 1: 加 UI 控件**

`src/renderer/settings/AdvancedSettings.tsx`：import 区把 `clampBackgroundConcurrency` 加入从 `@renderer/settings/settings-logic` 的导入。组件内顶部加 store 读写：

```ts
const backgroundConcurrency = usePrefsStore((s) => s.backgroundConcurrency);
const setBackgroundConcurrency = usePrefsStore((s) => s.setBackgroundConcurrency);
```

在「单次回复最多步数」那个 `<div className="flex items-start justify-between gap-3">…</div>` 块**之后**插入一行（同样的两段式 label + 右侧数字框，无「不限制」复选框）：

```tsx
<div className="flex items-start justify-between gap-3">
  <label htmlFor="background-concurrency" className="min-w-0 cursor-pointer">
    <span className="block text-sm font-medium">
      {t("settings.advanced.backgroundConcurrency", "后台任务并发上限")}
    </span>
    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
      {t(
        "settings.advanced.backgroundConcurrencyDesc",
        "同时进行的后台 AI 任务（章节/全书摘要、会话命名、长对话压缩）数量上限。调低可缓解额度/速率压力；不影响你正在进行的对话回复。",
      )}
    </span>
  </label>
  <Input
    id="background-concurrency"
    type="number"
    min={1}
    max={10}
    value={backgroundConcurrency}
    onChange={(e) => setBackgroundConcurrency(clampBackgroundConcurrency(e.target.valueAsNumber))}
    className="w-16 shrink-0"
  />
</div>
```

- [ ] **Step 2: 抽取 i18n key**

Run: `pnpm i18n:extract`
Expected: 主语言 locale 新增 `settings.advanced.backgroundConcurrency` 与 `...Desc` 两个 key（无报错）

- [ ] **Step 3: 校验 + typecheck + lint**

Run: `pnpm i18n:lint && pnpm typecheck && pnpm lint`
Expected: 全 PASS（i18n key 不缺漏）

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/AdvancedSettings.tsx src/shared/i18n/locales
git commit -m "feat(settings): add background concurrency control to Advanced panel"
```

---

## Task 7: 全量验证 + changeset

**Files:**

- Create: `.changeset/<generated>.md`

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全 PASS（含新增 limiter / cap / store / settings-logic 用例）

- [ ] **Step 2: 写 changeset**

Run: `pnpm changeset`（或手写一个 patch 级 md）。内容（英文，用户向）：

```md
---
"marginalia": patch
---

Add a configurable global concurrency cap for background AI tasks (chapter/book summaries, conversation naming, long-conversation compaction). Set it in Settings → Advanced (default 3). Foreground chat replies are never throttled.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: add changeset for background concurrency cap"
```

---

## Self-Review 备注（计划作者已核对）

- **Spec 覆盖**：Preference（Task 1）/ Limiter（Task 2）/ 四调用点注入与包裹（Task 3+4）/ 渲染层 store+hydrate+clamp（Task 5）/ Settings UI+i18n（Task 6）/ 验证+changeset（Task 7）。spec 中 `send-deps.test.ts` 实测只测 `createLoadBytes`、不构造 SendDeps/SummaryDeps，故**无需改动**（spec 列表的笔误，此处订正）。
- **类型一致**：`RunBackground` / `Limiter` / `backgroundConcurrencySchema` / `DEFAULT_BACKGROUND_CONCURRENCY` / `clampBackgroundConcurrency` / `setBackgroundConcurrency` 全程同名。
- **每个 commit 保持绿**：Task 1 同提交补 handler case（避免 `never` 守卫报错）；Task 3/4 把「加必填字段」与「所有构造点（生产 + 测试）补字段」放同一提交。
- **执行者注意**：Task 3/4 的 cap 断言测试依赖各测试文件既有 mock model fixture 的具体构造方式（`doGenerate` 受控 gate）；若 fixture 形状与示例不符，按文件实际写法对齐，核心是「cap=1 时第二个模型调用被推迟到第一个完成后」。
