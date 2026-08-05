# ePub 阅读位置状态机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `EpubReader` 与 `VirtualDocs` 中散落在 6 个 ref / 4 个 useState 的阅读位置控制逻辑，收口成两台显式的纯 reducer 状态机，使位置迁移可单测、可观测，并顺带消除「收敛超时后进度永不保存」的结构性缺陷。

**Architecture:** 双状态机 + 显式结果契约。`packages/virtual-docs` 内一台「视口所有权机」（systemOwned / aligning / userOwned），`src/renderer/reader` 内一台「阅读位置机」（loading / restoring / following）。两者经 `scrollToSectionElement(): Promise<"settled" | "timeout" | "cancelled">` 衔接。两台机的 reducer 签名统一为 `(state, event) => { next, effects }`，reducer 不碰 DOM、不起计时器、不调 store，副作用以数据形式返回、由执行器 hook 统一施行。

**Tech Stack:** TypeScript 6（strict）、React 19（渲染层启用 React Compiler）、vitest 4（`environment: "node"`，跑在 Electron 运行时）、zustand store、@tanstack/react-query。

**设计文档：** `docs/superpowers/specs/2026-08-05-reader-position-state-machine-design.md`

## Global Constraints

- **禁止裸 `console.*`**：主进程 `@main/logger`、渲染层 `@renderer/logger`，每文件模块级 `const log = createLogger("<module>")`。消息不带 `[xxx]` 前缀、不带尾冒号；Error 一律作第二参。
- **`packages/virtual-docs` 不得 import `@renderer/*`**：它是 store-agnostic 的独立包，诊断出口只能靠 prop 注入。
- **`virtual-docs` 不过 React Compiler**（经 node_modules 软链被 babel 的 `/node_modules/` 默认 exclude 排除）：该包内传给子组件/virtuoso 的回调**必须手动 `useCallback`** 稳定身份。`src/renderer/` 内则**禁止**手写 `useCallback` / `useMemo`（编译器自动记忆化）。
- **测试环境无 DOM**：`vitest.config.ts` 的 `environment: "node"`。只对纯 reducer 写单测，不对 React hook 写单测。
- **测试命令**：根目录 `pnpm test`（`include` 已覆盖 `src/**/*.test.ts` 与 `packages/*/src/**/*.test.ts`）。单文件用 `pnpm test <path>`，按名过滤用 `pnpm test -t "<name>"`。
- **提交信息**：Conventional Commits。
- **pre-commit hook（prek）** 会跑 `lint:fix` + `format`，可能改动暂存文件并以 "files were modified by this hook" 中止提交。遇到时重新 `git add` 被改文件、再跑一次相同的 commit 命令即可。
- **行为口径**：等价重构 + 修明确缺陷。滚动手感参数（`OVERSCAN_PX = { top: 2400, bottom: 2400 }`、`KEEP_DISTANCE = 5`、收敛的 60/5/300 阈值、100ms tick、1000ms 存盘 debounce）一律沿用现值。
- **不在范围**：`SectionFrame` 的高度测量机（L4）、PDF 侧、`precision.ts` 的既有纯函数及其测试。

## File Structure

| 文件                                                                 | 责任                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/virtual-docs/src/viewport-machine.ts`（新）                | L3 纯 reducer：视口所有权 + 定位收敛。无 DOM、无 React。                                                                           |
| `packages/virtual-docs/src/viewport-machine.test.ts`（新）           | L3 迁移规则单测。                                                                                                                  |
| `packages/virtual-docs/src/use-machine.ts`（新）                     | 两台机共用的通用执行器 hook：`useReducer` + 顺序执行 effects + 迁移打点。仅依赖 React。                                            |
| `packages/virtual-docs/src/index.ts`（改）                           | 导出 `useMachine` 及其类型。                                                                                                       |
| `packages/virtual-docs/src/VirtualDocs.tsx`（改）                    | 去掉 4 个 state/ref，改由 L3 机器驱动；新增 `getScrollerElement()`、`onTransition` prop；`scrollToSectionElement` 改返回 Promise。 |
| `packages/virtual-docs/src/scroll-convergence.ts` + `.test.ts`（删） | 逻辑并入 L3 reducer。                                                                                                              |
| `src/renderer/reader/reading-position-machine.ts`（新）              | L2 纯 reducer：阅读位置生命周期。无 DOM、无 React、无 store。                                                                      |
| `src/renderer/reader/reading-position-machine.test.ts`（新）         | L2 迁移规则单测。                                                                                                                  |
| `src/renderer/reader/use-reading-position.ts`（新）                  | L2 执行器 hook：执行 restore / 跳转 / 上报 / 存盘。                                                                                |
| `src/renderer/reader/epub-progress-restore.ts` + `.test.ts`（删）    | `advanceRestoreGate` 被 `state.kind === "following"` 取代。                                                                        |
| `src/renderer/reader/EpubReader.tsx`（改）                           | 位置逻辑外迁到执行器；保留渲染与选区/标注/链接处理。                                                                               |
| `src/renderer/reader/tts/tts-controller.ts`（改）                    | scroller 由 `ReaderTtsContext` 注入，删除全局 `.no-scrollbar` 查询。                                                               |

## Task 顺序与依赖

```
Task 1 (L3 reducer) → Task 2 (useMachine) → Task 3 (VirtualDocs 接线) ─┐
Task 4 (L2 reducer) ──────────────────────────────────────────────────┴→ Task 5 (EpubReader 接线) → Task 6 (scroller 注入) → Task 7 (收尾)
```

Task 2 依赖 Task 1（要从包入口再导出 `AlignResult`）。Task 4 与 Task 1/2 独立，可并行。Task 3 依赖 1+2；Task 5 依赖 3+4。

---

### Task 1: L3 视口所有权状态机（纯 reducer）

**Files:**

- Create: `packages/virtual-docs/src/viewport-machine.ts`
- Test: `packages/virtual-docs/src/viewport-machine.test.ts`

**Interfaces:**

- Consumes: 无（纯新增，不依赖任何既有模块）
- Produces:
  - `type AlignResult = "settled" | "timeout" | "cancelled"`
  - `type ViewportPhase`、`interface ViewportState`、`type ViewportEvent`、`type ViewportEffect`、`interface ViewportTransition`
  - `function initialViewportState(initialIndex: number): ViewportState`
  - `function reduceViewport(state: ViewportState, event: ViewportEvent): ViewportTransition`
  - `function rangeLoadingEnabled(state: ViewportState): boolean`
  - `function overscanTop(state: ViewportState, initialIndex: number, fullTop: number): number`
  - 常量 `ALIGN_MINIMUM_ATTEMPTS = 60`、`ALIGN_SUCCESSES_REQUIRED = 5`、`ALIGN_MAX_ATTEMPTS = 300`

**背景（实现者需要知道的）：** 这台机描述「此刻谁拥有滚动视口」。`aligning` 是命令式定位的收敛过程：每 100ms 由执行器测一次元素与滚动容器顶的偏差，把结果作为 `ALIGN_TICK` 事件喂进来。收敛判定刻意保守 —— 超长 section 的首次对齐可能是假象（前方 iframe 的迟到测高会在数秒后再次推开目标），故要求至少 60 次尝试（约 6 秒）且连续 5 次对齐。

`loadedFromIndex` 是「已开放加载的 section 下界」：小于它的 section 保持轻量占位，防止前方 section 的迟到测高把目标推走。它只减不增。`everUserNavigated` 是只进不退的锁存位，控制冷启深处时是否禁用顶部预挂载。

- [ ] **Step 1: 写失败的测试**

创建 `packages/virtual-docs/src/viewport-machine.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  ALIGN_MAX_ATTEMPTS,
  ALIGN_MINIMUM_ATTEMPTS,
  ALIGN_SUCCESSES_REQUIRED,
  initialViewportState,
  overscanTop,
  rangeLoadingEnabled,
  reduceViewport,
  type ViewportEvent,
  type ViewportState,
} from "./viewport-machine";

/** 连喂 n 个对齐结果一致的 tick，返回末态。 */
function tick(state: ViewportState, n: number, aligned: boolean): ViewportState {
  let s = state;
  for (let i = 0; i < n; i++) {
    if (s.phase.kind !== "aligning") break;
    s = reduceViewport(s, {
      type: "ALIGN_TICK",
      runId: s.phase.runId,
      aligned,
      offset: 120,
    }).next;
  }
  return s;
}

const align: ViewportEvent = { type: "ALIGN_REQUESTED", index: 40, owner: "restore" };

describe("reduceViewport", () => {
  it("starts a ticker and a section-level scroll when alignment is requested", () => {
    const { next, effects } = reduceViewport(initialViewportState(40), align);
    expect(next.phase).toMatchObject({ kind: "aligning", target: 40, owner: "restore" });
    expect(effects).toEqual([
      { kind: "scrollToIndex", index: 40 },
      { kind: "startTicker", runId: 1 },
    ]);
  });

  it("does not treat restoration as user navigation", () => {
    const { next } = reduceViewport(initialViewportState(40), align);
    expect(next.everUserNavigated).toBe(false);
  });

  it("settles only after the stability window and a full success streak", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    // 提前凑满 streak 也不能提前 settle：必须先跨过最小观察次数。
    const early = tick(started, ALIGN_SUCCESSES_REQUIRED, true);
    expect(early.phase.kind).toBe("aligning");

    const justBefore = tick(early, ALIGN_MINIMUM_ATTEMPTS - ALIGN_SUCCESSES_REQUIRED - 1, true);
    expect(justBefore.phase.kind).toBe("aligning");

    const last = reduceViewport(justBefore, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: true,
      offset: 0,
    });
    expect(last.next.phase.kind).toBe("systemOwned");
    expect(last.effects).toEqual([
      { kind: "stopTicker" },
      { kind: "reportAlignResult", result: "settled" },
      { kind: "recomputeTop" },
    ]);
  });

  it("resets the streak when an attempt misses", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    // 停在最小观察次数前一步：再喂一个对齐的 tick 就会 settle，故此处只能喂未对齐的。
    const hit = tick(started, ALIGN_MINIMUM_ATTEMPTS - 1, true);
    // 已跨过最小观察次数但中途未对齐 → streak 归零，不得 settle。
    const missed = reduceViewport(hit, { type: "ALIGN_TICK", runId: 1, aligned: false, offset: 5 });
    expect(missed.next.phase).toMatchObject({
      kind: "aligning",
      streak: 0,
      attempts: ALIGN_MINIMUM_ATTEMPTS,
    });
    expect(missed.effects).toEqual([{ kind: "scrollToIndex", index: 40, offset: 5 }]);
  });

  it("re-issues a section-level scroll when the element cannot be resolved", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { effects } = reduceViewport(started, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: false,
      offset: null,
    });
    expect(effects).toEqual([{ kind: "scrollToIndex", index: 40 }]);
  });

  it("reports a timeout after the attempt ceiling", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const exhausted = tick(started, ALIGN_MAX_ATTEMPTS, false);
    expect(exhausted.phase.kind).toBe("systemOwned");
    const last = tick(started, ALIGN_MAX_ATTEMPTS - 1, false);
    const final = reduceViewport(last, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: false,
      offset: null,
    });
    expect(final.effects).toContainEqual({ kind: "reportAlignResult", result: "timeout" });
  });

  it("ignores ticks from a superseded run", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const restarted = reduceViewport(started, {
      type: "ALIGN_REQUESTED",
      index: 7,
      owner: "user",
    }).next;
    const stale = reduceViewport(restarted, {
      type: "ALIGN_TICK",
      runId: 1,
      aligned: true,
      offset: 0,
    });
    expect(stale.next).toBe(restarted);
    expect(stale.effects).toEqual([]);
  });

  it("cancels the in-flight alignment when a new one is requested", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { effects } = reduceViewport(started, {
      type: "ALIGN_REQUESTED",
      index: 7,
      owner: "user",
    });
    expect(effects[0]).toEqual({ kind: "reportAlignResult", result: "cancelled" });
    expect(effects).toContainEqual({ kind: "stopTicker" });
  });

  it("hands the viewport to the user on scroll intent and cancels alignment", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { next, effects } = reduceViewport(started, {
      type: "USER_INPUT",
      scrollIntent: true,
    });
    expect(next.phase.kind).toBe("userOwned");
    expect(next.everUserNavigated).toBe(true);
    expect(effects).toContainEqual({ kind: "reportAlignResult", result: "cancelled" });
  });

  it("cancels alignment on a bare pointerdown without taking ownership", () => {
    const started = reduceViewport(initialViewportState(40), align).next;
    const { next, effects } = reduceViewport(started, {
      type: "USER_INPUT",
      scrollIntent: false,
    });
    expect(next.phase.kind).toBe("systemOwned");
    expect(next.everUserNavigated).toBe(false);
    expect(effects).toContainEqual({ kind: "reportAlignResult", result: "cancelled" });
  });

  it("advances the loaded frontier only while the user owns the viewport", () => {
    const initial = initialViewportState(40);
    const ignored = reduceViewport(initial, { type: "VISIBLE_TOP_CHANGED", index: 12 });
    expect(ignored.next.loadedFromIndex).toBe(40);

    const owned = reduceViewport(initial, { type: "USER_INPUT", scrollIntent: true }).next;
    const advanced = reduceViewport(owned, { type: "VISIBLE_TOP_CHANGED", index: 12 }).next;
    expect(advanced.loadedFromIndex).toBe(12);
  });

  it("never moves the loaded frontier forward", () => {
    const owned = reduceViewport(initialViewportState(40), {
      type: "USER_INPUT",
      scrollIntent: true,
    }).next;
    const back = reduceViewport(owned, { type: "VISIBLE_TOP_CHANGED", index: 12 }).next;
    const forward = reduceViewport(back, { type: "VISIBLE_TOP_CHANGED", index: 30 }).next;
    expect(forward.loadedFromIndex).toBe(12);
  });

  it("marks a command-level jump as user navigation", () => {
    const { next, effects } = reduceViewport(initialViewportState(40), {
      type: "JUMP_REQUESTED",
      index: 3,
    });
    expect(next.phase.kind).toBe("systemOwned");
    expect(next.everUserNavigated).toBe(true);
    expect(next.loadedFromIndex).toBe(3);
    expect(effects).toEqual([{ kind: "scrollToIndex", index: 3 }]);
  });

  it("derives range loading and overscan from the phase", () => {
    const initial = initialViewportState(40);
    expect(rangeLoadingEnabled(initial)).toBe(false);
    expect(overscanTop(initial, 40, 2400)).toBe(0);
    expect(overscanTop(initial, 0, 2400)).toBe(2400);

    const owned = reduceViewport(initial, { type: "USER_INPUT", scrollIntent: true }).next;
    expect(rangeLoadingEnabled(owned)).toBe(true);
    expect(overscanTop(owned, 40, 2400)).toBe(2400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/virtual-docs/src/viewport-machine.test.ts`
Expected: FAIL —— `Failed to resolve import "./viewport-machine"`

- [ ] **Step 3: 写实现**

创建 `packages/virtual-docs/src/viewport-machine.ts`：

```ts
/**
 * 视口所有权状态机（纯逻辑，无 DOM / React）。
 *
 * 描述「此刻谁拥有滚动视口，命令式定位收敛到哪一步」。所有副作用以 effect 描述返回，
 * 由 VirtualDocs 内的执行器施行；reducer 本身可直接单测。
 */

/** 收敛的终态。三者都会兑现 scrollToSectionElement 返回的 Promise，不存在悬挂路径。 */
export type AlignResult = "settled" | "timeout" | "cancelled";

/**
 * 收敛判定阈值。超长 section 的首次对齐可能是假象——前方 iframe 的迟到测高会在数秒后
 * 再次推开目标——故要求至少观察 6 秒（60 × 100ms）且连续 5 次对齐才认定稳定。
 */
export const ALIGN_MINIMUM_ATTEMPTS = 60;
export const ALIGN_SUCCESSES_REQUIRED = 5;
/** 上限 30 秒，覆盖冷启超长 section 的迟到测量；到顶即报 timeout，不卡死。 */
export const ALIGN_MAX_ATTEMPTS = 300;

export type ViewportPhase =
  | { kind: "systemOwned" }
  | {
      kind: "aligning";
      runId: number;
      target: number;
      owner: "restore" | "user";
      attempts: number;
      streak: number;
    }
  | { kind: "userOwned" };

export interface ViewportState {
  phase: ViewportPhase;
  /** 已开放加载的 section 下界；小于它的保持轻量占位。只减不增。 */
  loadedFromIndex: number;
  /** 是否发生过用户级导航（含命令式跳章）。只进不退；恢复不计。 */
  everUserNavigated: boolean;
  nextRunId: number;
}

export type ViewportEvent =
  | { type: "ALIGN_REQUESTED"; index: number; owner: "restore" | "user" }
  | { type: "JUMP_REQUESTED"; index: number }
  /** offset = 目标元素相对 section 顶的偏移；null 表示元素尚不可解析。 */
  | { type: "ALIGN_TICK"; runId: number; aligned: boolean; offset: number | null }
  /** scrollIntent 区分「明确推动阅读位置的输入」（wheel/touch/key）与裸 pointerdown。 */
  | { type: "USER_INPUT"; scrollIntent: boolean }
  | { type: "VISIBLE_TOP_CHANGED"; index: number };

export type ViewportEffect =
  | { kind: "scrollToIndex"; index: number; offset?: number }
  | { kind: "startTicker"; runId: number }
  | { kind: "stopTicker" }
  | { kind: "reportAlignResult"; result: AlignResult }
  | { kind: "recomputeTop" };

export interface ViewportTransition {
  next: ViewportState;
  effects: ViewportEffect[];
}

export function initialViewportState(initialIndex: number): ViewportState {
  return {
    phase: { kind: "systemOwned" },
    loadedFromIndex: initialIndex,
    everUserNavigated: false,
    nextRunId: 1,
  };
}

/** 进行中的收敛被抢占/取消时要发的效果（顺序：先兑现结果，再停表）。 */
function cancelEffects(state: ViewportState): ViewportEffect[] {
  return state.phase.kind === "aligning"
    ? [{ kind: "reportAlignResult", result: "cancelled" }, { kind: "stopTicker" }]
    : [];
}

export function reduceViewport(state: ViewportState, event: ViewportEvent): ViewportTransition {
  switch (event.type) {
    case "ALIGN_REQUESTED": {
      const runId = state.nextRunId;
      return {
        next: {
          phase: {
            kind: "aligning",
            runId,
            target: event.index,
            owner: event.owner,
            attempts: 0,
            streak: 0,
          },
          loadedFromIndex: Math.min(state.loadedFromIndex, event.index),
          everUserNavigated: state.everUserNavigated || event.owner === "user",
          nextRunId: runId + 1,
        },
        effects: [
          ...cancelEffects(state),
          { kind: "scrollToIndex", index: event.index },
          { kind: "startTicker", runId },
        ],
      };
    }

    case "JUMP_REQUESTED":
      return {
        next: {
          ...state,
          phase: { kind: "systemOwned" },
          loadedFromIndex: Math.min(state.loadedFromIndex, event.index),
          everUserNavigated: true,
        },
        effects: [...cancelEffects(state), { kind: "scrollToIndex", index: event.index }],
      };

    case "ALIGN_TICK": {
      // 旧 runId 的在途 tick 不得污染新一轮定位。
      if (state.phase.kind !== "aligning" || state.phase.runId !== event.runId)
        return { next: state, effects: [] };
      const attempts = state.phase.attempts + 1;
      const streak = event.aligned ? state.phase.streak + 1 : 0;
      if (attempts >= ALIGN_MINIMUM_ATTEMPTS && streak >= ALIGN_SUCCESSES_REQUIRED)
        return {
          next: { ...state, phase: { kind: "systemOwned" } },
          effects: [
            { kind: "stopTicker" },
            { kind: "reportAlignResult", result: "settled" },
            { kind: "recomputeTop" },
          ],
        };
      if (attempts >= ALIGN_MAX_ATTEMPTS)
        return {
          next: { ...state, phase: { kind: "systemOwned" } },
          effects: [{ kind: "stopTicker" }, { kind: "reportAlignResult", result: "timeout" }],
        };
      const target = state.phase.target;
      return {
        next: { ...state, phase: { ...state.phase, attempts, streak } },
        effects: event.aligned
          ? []
          : [
              // 元素不可解析时退回 section 级定位：目标 iframe 尚未挂载，用最新高度表
              // 重发一次把它带进渲染窗口，下一 tick 再解析元素。
              event.offset == null
                ? { kind: "scrollToIndex", index: target }
                : { kind: "scrollToIndex", index: target, offset: event.offset },
            ],
      };
    }

    case "USER_INPUT": {
      const effects = cancelEffects(state);
      // 裸 pointerdown 只取消进行中的定位，不转移视口所有权（与既有行为一致）。
      if (!event.scrollIntent)
        return {
          next:
            state.phase.kind === "aligning" ? { ...state, phase: { kind: "systemOwned" } } : state,
          effects,
        };
      return {
        next: { ...state, phase: { kind: "userOwned" }, everUserNavigated: true },
        effects,
      };
    }

    case "VISIBLE_TOP_CHANGED": {
      if (state.phase.kind !== "userOwned") return { next: state, effects: [] };
      const loadedFromIndex = Math.min(state.loadedFromIndex, event.index);
      if (loadedFromIndex === state.loadedFromIndex) return { next: state, effects: [] };
      return { next: { ...state, loadedFromIndex }, effects: [] };
    }
  }
}

/** 只有用户拥有视口时，才随真实可视顶部向前开放 section。 */
export function rangeLoadingEnabled(state: ViewportState): boolean {
  return state.phase.kind === "userOwned";
}

/**
 * 深处冷启且用户尚未导航过时禁用顶部预挂载：上方 section 的迟到测高会推走恢复目标。
 * 一旦发生用户级导航即永久恢复双向 overscan。
 */
export function overscanTop(state: ViewportState, initialIndex: number, fullTop: number): number {
  return initialIndex > 0 && !state.everUserNavigated ? 0 : fullTop;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test packages/virtual-docs/src/viewport-machine.test.ts`
Expected: PASS，14 个用例全绿

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 无输出（通过）

- [ ] **Step 6: 提交**

```bash
git add packages/virtual-docs/src/viewport-machine.ts packages/virtual-docs/src/viewport-machine.test.ts
git commit -m "feat(virtual-docs): add viewport ownership state machine"
```

---

### Task 2: 通用执行器 hook `useMachine`

**Files:**

- Create: `packages/virtual-docs/src/use-machine.ts`
- Modify: `packages/virtual-docs/src/index.ts`

**Interfaces:**

- Consumes: Task 1 的 `AlignResult`（仅为从包入口再导出，不使用其值）
- Produces:
  - `interface MachineTransition<S, F> { next: S; effects: F[] }`
  - `interface TransitionRecord { event: string; from: string; to: string; effects: string[] }`
  - `function useMachine<S, E extends { type: string }, F extends { kind: string }>(reduce, initial, runEffect, options?): [S, (event: E) => void]`
  - `options: { describeState?: (s: S) => string; onTransition?: (r: TransitionRecord) => void }`

**背景：** 这是两台机共用的执行器。职责有三：把 reducer 接到 `useReducer`、顺序执行本次迁移产生的 effects、把迁移交给 `onTransition` 打点。**它不做任何领域判断。**

注意两个实现约束：

1. **effects 必须在渲染之后执行**，不能在 reducer 内执行（reducer 在 React 严格模式下可能被调用两次）。做法是把 effects 排进一个队列 ref，在 `useEffect` 中排空。
2. **`runEffect` 的身份不稳定**（消费方每渲染新建闭包），所以用 ref 持最新值，避免 effect 重跑。本包不过 React Compiler，这类手写记忆化是必须的。

- [ ] **Step 1: 写实现**

本任务无单测：`vitest.config.ts` 的 `environment: "node"` 无 DOM，React hook 无法在此环境渲染。正确性由 Task 1/4 的 reducer 单测 + Task 3/5 的真书手测共同覆盖。

创建 `packages/virtual-docs/src/use-machine.ts`：

```ts
import { useCallback, useEffect, useReducer, useRef } from "react";

export interface MachineTransition<S, F> {
  next: S;
  effects: F[];
}

/** 一次迁移的诊断记录；消费方转给自己的 logger（本包不引日志依赖）。 */
export interface TransitionRecord {
  event: string;
  from: string;
  to: string;
  effects: string[];
}

export interface UseMachineOptions<S> {
  /** 把状态压成一行标签用于打点；不传则用 JSON 之外的兜底（见实现）。 */
  describeState?: (state: S) => string;
  onTransition?: (record: TransitionRecord) => void;
}

/**
 * 把「纯 reducer + effect 描述」接进 React：dispatch 是唯一的状态写入口，
 * effects 在提交后按序执行，每次迁移经 onTransition 打点。
 *
 * 本包不过 React Compiler，故内部回调一律手写 useCallback / ref 稳定身份。
 */
export function useMachine<S, E extends { type: string }, F extends { kind: string }>(
  reduce: (state: S, event: E) => MachineTransition<S, F>,
  initial: S,
  runEffect: (effect: F) => void,
  options?: UseMachineOptions<S>,
): [S, (event: E) => void] {
  const runEffectRef = useRef(runEffect);
  runEffectRef.current = runEffect;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 待办 effects 与打点素材都进 reducer 的返回值，绝不写在 reducer 体内：渲染层启用了
  // StrictMode，React 会双调用 reducer 以暴露不纯实现——体内的副作用会跑两次（effects 入队
  // 两份、日志打两份），而返回值只提交一次。seq 让「同一批 effects」只被排空一次。
  const [committed, dispatch] = useReducer(
    (current: Committed<S, F>, event: E): Committed<S, F> => {
      const { next, effects } = reduce(current.state, event);
      const describe = optionsRef.current?.describeState;
      return {
        state: next,
        effects,
        seq: current.seq + 1,
        record: {
          event: event.type,
          from: describe ? describe(current.state) : "?",
          to: describe ? describe(next) : "?",
          effects: effects.map((e) => e.kind),
        },
      };
    },
    { state: initial, effects: [], seq: 0, record: null },
  );

  useEffect(() => {
    if (committed.record) optionsRef.current?.onTransition?.(committed.record);
    for (const effect of committed.effects) runEffectRef.current(effect);
    // 按 seq 触发：同一次 dispatch 的产物只排空一次，即使前后两批 effects 内容相同。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.seq]);

  const raise = useCallback((event: E) => dispatch(event), []);
  return [committed.state, raise];
}

interface Committed<S, F> {
  state: S;
  effects: F[];
  seq: number;
  record: TransitionRecord | null;
}
```

⚠️ **不要把 effects 入队或打点写进 reducer 体内。** 渲染层 `src/renderer.tsx` 启用了 `StrictMode`，React 会双调用 reducer 来暴露不纯实现；被丢弃的只是返回值，reducer 体内的副作用照跑两次。日志双份会直接损害本次重构要建立的诊断能力（`pnpm dev` 正是排查跳动的环境）。

- [ ] **Step 2: 从包入口导出**

修改 `packages/virtual-docs/src/index.ts`，在文件末尾追加：

```ts
export { useMachine } from "./use-machine";
export type { MachineTransition, TransitionRecord, UseMachineOptions } from "./use-machine";
export type { AlignResult } from "./viewport-machine";
```

`AlignResult` 是接缝契约的返回类型，renderer 侧的 L2 状态机要引用它，故一并从包入口导出。

⚠️ 本步依赖 Task 1 已创建 `viewport-machine.ts`，否则 `pnpm typecheck` 会报模块找不到。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 无输出（通过）

- [ ] **Step 4: 确认既有测试未受影响**

Run: `pnpm test`
Expected: PASS（本任务未改动任何被测模块）

- [ ] **Step 5: 提交**

```bash
git add packages/virtual-docs/src/use-machine.ts packages/virtual-docs/src/index.ts
git commit -m "feat(virtual-docs): add shared machine executor hook"
```

---

### Task 3: `VirtualDocs` 接入 L3 状态机

**Files:**

- Modify: `packages/virtual-docs/src/VirtualDocs.tsx`
- Delete: `packages/virtual-docs/src/scroll-convergence.ts`
- Delete: `packages/virtual-docs/src/scroll-convergence.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `reduceViewport` / `initialViewportState` / `rangeLoadingEnabled` / `overscanTop` / `AlignResult`；Task 2 的 `useMachine`
- Produces（`VirtualDocsHandle` 的新形态）：
  - `scrollToIndex(index: number): void`
  - `scrollToAnchor(index: number, anchorId: string): Promise<AlignResult>`
  - `scrollToSectionElement(index, resolveEl, opts: { owner: "restore" | "user" }): Promise<AlignResult>`
  - `redecorate(): void`
  - `getScrollerElement(): HTMLElement | null`
- Produces（`VirtualDocsProps` 新增）：`onTransition?: (record: TransitionRecord) => void`

**背景：** 这是本计划风险最高的一步 —— 要在保持行为等价的前提下换掉 4 个 state/ref。逐项对照：

| 旧                                           | 新                                                  |
| -------------------------------------------- | --------------------------------------------------- |
| `cancelScrollRef` + `startScrollConvergence` | `aligning` 相位 + ticker effect                     |
| `loadedFromIndex` (useState)                 | `state.loadedFromIndex`                             |
| `rangeLoadingEnabledRef`                     | `rangeLoadingEnabled(state)`                        |
| `userNavigationStarted` (useState)           | `overscanTop(state, initialIndex, OVERSCAN_PX.top)` |

`attempt()` 里的 DOM 几何计算**留在执行器**（reducer 不碰 DOM），但只负责算出 `aligned` 与 `offset`，不再自己决定重发。

- [ ] **Step 1: 替换 imports 与状态声明**

在 `packages/virtual-docs/src/VirtualDocs.tsx` 中，删除这一行：

```ts
import { startScrollConvergence } from "./scroll-convergence";
```

改为：

```ts
import {
  initialViewportState,
  overscanTop,
  rangeLoadingEnabled,
  reduceViewport,
  type AlignResult,
  type ViewportEffect,
  type ViewportEvent,
} from "./viewport-machine";
import { useMachine, type TransitionRecord } from "./use-machine";
```

删除这三行状态声明（位于 `const [decorateNonce, setDecorateNonce] = useState(0);` 附近）：

```ts
const [userNavigationStarted, setUserNavigationStarted] = useState(false);
const [loadedFromIndex, setLoadedFromIndex] = useState(initialIndex ?? 0);
const rangeLoadingEnabledRef = useRef(false);
```

**保留** `const [scrollerReady, setScrollerReady] = useState(0);` —— 它是 scroller 挂载的 nonce，与本状态机无关。

同时删除 `cancelScrollRef` 与 `cancelPendingScroll`：

```ts
const cancelScrollRef = useRef<(() => void) | null>(null);
const cancelPendingScroll = useCallback(() => {
  cancelScrollRef.current?.();
  cancelScrollRef.current = null;
}, []);
```

- [ ] **Step 2: 加入执行器所需的 ref 与 effect 运行器**

在 `const vRef = useRef<VirtuosoHandle | null>(null);` 之后加入：

```ts
/** 收敛 ticker 句柄与目标元素解析器（每轮定位一套）。 */
const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
const resolveElRef = useRef<((doc: Document) => Element | null) | null>(null);
const alignTargetRef = useRef<number | null>(null);
/** scrollToSectionElement 返回的 Promise 的兑现函数；由 reportAlignResult 效果兑现。 */
const alignResolveRef = useRef<((result: AlignResult) => void) | null>(null);
/** ticker 回调里要用 raise，但它在 useMachine 之后才存在——先声明 ref，之后回填。 */
const raiseRef = useRef<((event: ViewportEvent) => void) | null>(null);
```

`ViewportEvent` 需一并加入 Task 1 模块的 import 列表。

在 `recomputeRef` 定义之后（它需要 `recomputeRef` 已存在）加入 effect 运行器：

```ts
/** 测一次目标元素与 scroller 顶的偏差，供 ALIGN_TICK 携带。reducer 不碰 DOM，几何计算留在这里。 */
const measureAlignment = useCallback((): { aligned: boolean; offset: number | null } => {
  const index = alignTargetRef.current;
  const resolveEl = resolveElRef.current;
  const scroller = scrollerEl.current;
  if (index == null || !resolveEl || !scroller) return { aligned: false, offset: null };
  const frame = scroller.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
  const doc = frame?.contentDocument;
  const docRoot = doc?.documentElement;
  const el = doc && docRoot && docRoot.scrollHeight > 0 ? resolveEl(doc) : null;
  if (!el || !docRoot || !frame) return { aligned: false, offset: null };
  const offset = el.getBoundingClientRect().top - docRoot.getBoundingClientRect().top;
  const delta = frame.getBoundingClientRect().top + offset - scroller.getBoundingClientRect().top;
  return { aligned: Math.abs(delta) <= 4, offset };
}, []);

const runViewportEffect = (effect: ViewportEffect) => {
  switch (effect.kind) {
    case "scrollToIndex":
      vRef.current?.scrollToIndex({
        index: effect.index,
        align: "start",
        ...(effect.offset == null ? {} : { offset: effect.offset }),
      });
      return;
    case "startTicker": {
      if (tickerRef.current) clearInterval(tickerRef.current);
      const runId = effect.runId;
      tickerRef.current = setInterval(() => {
        const { aligned, offset } = measureAlignment();
        raiseRef.current?.({ type: "ALIGN_TICK", runId, aligned, offset });
      }, ALIGN_TICK_MS);
      return;
    }
    case "stopTicker":
      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = null;
      alignTargetRef.current = null;
      resolveElRef.current = null;
      return;
    case "reportAlignResult": {
      const resolve = alignResolveRef.current;
      alignResolveRef.current = null;
      resolve?.(effect.result);
      return;
    }
    case "recomputeTop":
      recomputeRef.current(true);
      return;
  }
};

const [viewport, raise] = useMachine(
  reduceViewport,
  initialViewportState(initialIndex ?? 0),
  runViewportEffect,
  {
    describeState: (s) => s.phase.kind,
    onTransition,
  },
);
raiseRef.current = raise;
```

在文件顶部常量区（`OVERSCAN_PX` 之后）加入：

```ts
/** 收敛重试间隔（ms）。 */
const ALIGN_TICK_MS = 100;
```

在 props 解构中加入 `onTransition`，并在 `VirtualDocsProps` 接口中加入：

```ts
/** 每次视口状态迁移的诊断记录；消费方转给自己的 logger（本包不引日志依赖）。 */
onTransition?: (record: TransitionRecord) => void;
```

- [ ] **Step 3: 重写 `useImperativeHandle`**

把整个 `useImperativeHandle(ref, () => { ... }, [cancelPendingScroll])` 块替换为：

```ts
useImperativeHandle(ref, () => {
  const scrollToSectionElement = (
    index: number,
    resolveEl: (doc: Document) => Element | null,
    opts: { owner: "restore" | "user" },
  ): Promise<AlignResult> => {
    alignTargetRef.current = index;
    resolveElRef.current = resolveEl;
    return new Promise<AlignResult>((resolve) => {
      alignResolveRef.current = resolve;
      raise({ type: "ALIGN_REQUESTED", index, owner: opts.owner });
    });
  };
  return {
    scrollToIndex: (index: number) => raise({ type: "JUMP_REQUESTED", index }),
    scrollToAnchor: (index: number, anchorId: string) =>
      scrollToSectionElement(index, (doc) => doc.getElementById(anchorId), { owner: "user" }),
    scrollToSectionElement,
    redecorate: () => setDecorateNonce((n) => n + 1),
    getScrollerElement: () => scrollerEl.current,
  };
}, [raise]);
```

注意 `alignResolveRef` 的赋值必须在 `raise` **之前**：`ALIGN_REQUESTED` 会同步产生 `reportAlignResult:"cancelled"` 效果去兑现**上一轮**的 Promise，若顺序颠倒会把新 Promise 当成旧的兑现掉。effects 在提交后才执行，故此处赋值顺序足够安全 —— 但仍按此顺序书写以免后续改动踩坑。

同步更新 `VirtualDocsHandle` 接口：

```ts
export interface VirtualDocsHandle {
  /** 滚到第 index 个 section 顶（无收敛重试）。 */
  scrollToIndex: (index: number) => void;
  /** 滚到第 index 个 section 内 id===anchorId 的元素处。 */
  scrollToAnchor: (index: number, anchorId: string) => Promise<AlignResult>;
  /**
   * 滚到第 index 个 section 内由 resolveEl(doc) 定位的元素处（doc = 该 section 的 iframe 文档；
   * 返回 null = 元素未就绪，继续重试）。收敛重试：virtuoso 须先测得 item 真高才认大 offset。
   * 返回的 Promise 在收敛成功 / 超时 / 被抢占三种情形下都会兑现，绝不悬挂。
   * owner 区分调用来源：restore 不计作用户导航（保持顶部 overscan 为 0），user 计。
   */
  scrollToSectionElement: (
    index: number,
    resolveEl: (doc: Document) => Element | null,
    opts: { owner: "restore" | "user" },
  ) => Promise<AlignResult>;
  /** 对所有在挂 section 重跑 decorate（标注增删改后调用）。 */
  redecorate: () => void;
  /** 真实滚动容器；消费方做视口几何计算时用，避免全局选择器耦合。 */
  getScrollerElement: () => HTMLElement | null;
}
```

- [ ] **Step 4: 改用状态派生值**

`recomputeTop` 中把：

```ts
if (section) {
  setLoadedFromIndex((current) =>
    loadedFromIndexAfterVisibleTop(current, section.index, rangeLoadingEnabledRef.current),
  );
}
```

替换为：

```ts
if (section) raise({ type: "VISIBLE_TOP_CHANGED", index: section.index });
```

用户输入回调改为：

```ts
const handleUserNavigation = useCallback(() => {
  raise({ type: "USER_INPUT", scrollIntent: false });
  onUserNavigationRef.current?.();
}, [raise]);
const handleUserScrollNavigation = useCallback(() => {
  raise({ type: "USER_INPUT", scrollIntent: true });
  onUserNavigationRef.current?.();
}, [raise]);
```

卸载清理（替换 `useEffect(() => cancelPendingScroll, [cancelPendingScroll]);`）：

```ts
useEffect(
  () => () => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;
  },
  [],
);
```

`itemContent` 中 `deferLoad` 的实参改为 `deferBeforeLoadedIndex(viewport.loadedFromIndex, index)`；其 deps 数组中把 `loadedFromIndex` 换成 `viewport.loadedFromIndex`、删除 `userNavigationStarted`。

`Virtuoso` 的 `increaseViewportBy` 改为：

```ts
increaseViewportBy={{
  top: overscanTop(viewport, initialIndex ?? 0, OVERSCAN_PX.top),
  bottom: OVERSCAN_PX.bottom,
}}
```

`precision.ts` 中的 `loadedFromIndexAfterNavigation` 与 `loadedFromIndexAfterVisibleTop` 已无调用方，从 import 中移除（保留其定义与测试不动，属范围外文件）。

- [ ] **Step 5: 删除 `scroll-convergence`**

```bash
git rm packages/virtual-docs/src/scroll-convergence.ts packages/virtual-docs/src/scroll-convergence.test.ts
```

其四个用例的语义已由 Task 1 的 `viewport-machine.test.ts` 覆盖：重试至对齐 → "settles only after the stability window"；不接受瞬时对齐 → "resets the streak when an attempt misses"；取消后不再发命令 → "hands the viewport to the user on scroll intent"；耗尽只报一次 → "reports a timeout after the attempt ceiling"。

- [ ] **Step 6: 类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 无输出；test 全绿（`EpubReader.tsx` 尚未更新调用签名，若 typecheck 报 `scrollToSectionElement` 实参不匹配，改 `EpubReader.tsx` 的两处调用点加上 `{ owner: "restore" }` / `{ owner: "user" }` 作为临时适配 —— Task 5 会彻底重写这两处）

- [ ] **Step 7: 手测（真书）**

Run: `pnpm dev`，导入或打开一本长 ePub。逐项确认：

1. 冷启恢复到上次深处位置，不闪开头；
2. 恢复过程中滚动滚轮能立刻夺回控制权，不被拽回；
3. 侧栏点章跳转到位；
4. 点标注列表条目精确跳到该标注。

- [ ] **Step 8: 提交**

```bash
git add packages/virtual-docs/src/VirtualDocs.tsx
git commit -m "refactor(virtual-docs): drive viewport ownership by explicit state machine"
```

---

### Task 4: L2 阅读位置状态机（纯 reducer）

**Files:**

- Create: `src/renderer/reader/reading-position-machine.ts`
- Test: `src/renderer/reader/reading-position-machine.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `AlignResult` 类型（从 `@marginalia/virtual-docs` 导入）
- Produces:
  - `interface ReadingPosition`
  - `type ReadingPositionState`、`type ReadingPositionEvent`、`type ReadingPositionEffect`、`interface ReadingPositionTransition`
  - `function initialReadingPositionState(): ReadingPositionState`
  - `function reduceReadingPosition(state, event): ReadingPositionTransition`

**背景：** 这台机描述一本书的阅读位置生命周期。核心不变量是**只有 `following` 状态才持久化进度** —— 恢复过程中虚拟列表会先短暂落在中间 section，此时存盘会把错误位置写死。

`ReadingPosition` 是执行器在派发 `TOP_SECTION_CHANGED` **之前**算好的完整位置快照（CFI、百分比、章节归属都需要 DOM 几何，reducer 不做这些）。reducer 只决定这份快照是只上报、还是同时存盘。

- [ ] **Step 1: 写失败的测试**

创建 `src/renderer/reader/reading-position-machine.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  initialReadingPositionState,
  reduceReadingPosition,
  type ReadingPosition,
  type ReadingPositionState,
} from "./reading-position-machine";

const position: ReadingPosition = {
  index: 12,
  scrollRatio: 0.25,
  cfi: "epubcfi(/6/24!/4/2/2[p3])",
  percent: 0.31,
  chapterId: "ch-7",
  chapterTitle: "第七章",
  offset: 480,
};

const ready = { type: "SESSION_READY", locator: "epubcfi(/6/24!/4)", targetIndex: 11 } as const;

/** 走到 following：开书 → 恢复 → 收敛完成。 */
function following(): ReadingPositionState {
  const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
  return reduceReadingPosition(restoring, { type: "RESTORE_FINISHED", result: "settled" }).next;
}

describe("reduceReadingPosition", () => {
  it("enters restoring with a stored locator", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), ready);
    expect(next).toEqual({
      kind: "restoring",
      targetIndex: 11,
      locator: "epubcfi(/6/24!/4)",
    });
    expect(effects).toEqual([
      { kind: "restoreToCfi", locator: "epubcfi(/6/24!/4)", targetIndex: 11 },
    ]);
  });

  it("goes straight to following when there is nothing to restore", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), {
      type: "SESSION_READY",
      locator: null,
      targetIndex: null,
    });
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([]);
  });

  it("goes to following when the stored locator resolves to no section", () => {
    const { next, effects } = reduceReadingPosition(initialReadingPositionState(), {
      type: "SESSION_READY",
      locator: "epubcfi(/6/999!/4)",
      targetIndex: null,
    });
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([]);
  });

  it("ignores a repeated session-ready once past loading", () => {
    const state = following();
    const { next, effects } = reduceReadingPosition(state, ready);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("leaves restoring on every alignment outcome", () => {
    for (const result of ["settled", "timeout", "cancelled"] as const) {
      const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
      const { next } = reduceReadingPosition(restoring, { type: "RESTORE_FINISHED", result });
      expect(next).toEqual({ kind: "following" });
    }
  });

  it("persists progress only once following", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const during = reduceReadingPosition(restoring, { type: "TOP_SECTION_CHANGED", position });
    expect(during.effects).toEqual([{ kind: "reportPosition", position }]);

    const after = reduceReadingPosition(following(), { type: "TOP_SECTION_CHANGED", position });
    expect(after.effects).toEqual([
      { kind: "reportPosition", position },
      { kind: "persistProgress", position },
    ]);
  });

  it("resumes persistence after an alignment timeout", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const timedOut = reduceReadingPosition(restoring, {
      type: "RESTORE_FINISHED",
      result: "timeout",
    }).next;
    const { effects } = reduceReadingPosition(timedOut, { type: "TOP_SECTION_CHANGED", position });
    expect(effects).toContainEqual({ kind: "persistProgress", position });
  });

  it("hands control to the user mid-restore", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const { next } = reduceReadingPosition(restoring, { type: "USER_NAVIGATED" });
    expect(next).toEqual({ kind: "following" });
  });

  it("ignores navigation requests while loading", () => {
    const loading = initialReadingPositionState();
    expect(
      reduceReadingPosition(loading, { type: "CHAPTER_REQUESTED", chapterId: "ch-2" }),
    ).toEqual({ next: loading, effects: [] });
    expect(
      reduceReadingPosition(loading, { type: "ANNOTATION_SCROLL", locator: "epubcfi(/6/8!/4)" }),
    ).toEqual({ next: loading, effects: [] });
    expect(reduceReadingPosition(loading, { type: "USER_NAVIGATED" })).toEqual({
      next: loading,
      effects: [],
    });
  });

  it("abandons an in-flight restore when a chapter jump is requested", () => {
    const restoring = reduceReadingPosition(initialReadingPositionState(), ready).next;
    const { next, effects } = reduceReadingPosition(restoring, {
      type: "CHAPTER_REQUESTED",
      chapterId: "ch-2",
    });
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([
      { kind: "notifyTtsUserNavigation" },
      { kind: "scrollToChapter", chapterId: "ch-2" },
    ]);
  });

  it("scrolls to an annotation without leaving following", () => {
    const { next, effects } = reduceReadingPosition(following(), {
      type: "ANNOTATION_SCROLL",
      locator: "epubcfi(/6/8!/4/2)",
    });
    expect(next).toEqual({ kind: "following" });
    expect(effects).toEqual([
      { kind: "notifyTtsUserNavigation" },
      { kind: "scrollToAnnotation", locator: "epubcfi(/6/8!/4/2)" },
    ]);
  });

  it("returns to loading when the book changes", () => {
    const { next, effects } = reduceReadingPosition(following(), { type: "BOOK_CHANGED" });
    expect(next).toEqual({ kind: "loading" });
    expect(effects).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/reading-position-machine.test.ts`
Expected: FAIL —— `Failed to resolve import "./reading-position-machine"`

- [ ] **Step 3: 写实现**

创建 `src/renderer/reader/reading-position-machine.ts`：

```ts
import type { AlignResult } from "@marginalia/virtual-docs";

/**
 * 阅读位置状态机（纯逻辑，无 DOM / React / store）。
 *
 * 核心不变量：只有 following 才持久化进度。恢复过程中虚拟列表会先短暂落在中间 section，
 * 此时存盘会把错误位置写死；恢复结束（成功 / 超时 / 被用户抢占）后才放开。
 */

/** 执行器在派发 TOP_SECTION_CHANGED 前算好的位置快照（CFI / 百分比 / 章节归属都需 DOM 几何）。 */
export interface ReadingPosition {
  /** 视口顶 section 的 spine 索引。 */
  index: number;
  /** 视口顶在该 section 内的相对位置，0–1。 */
  scrollRatio: number;
  /** 视口顶那个块级元素首字符的 range CFI。 */
  cfi: string;
  /** 全书阅读进度，0–1。 */
  percent: number;
  chapterId: string | null;
  chapterTitle: string | null;
  /** 「读我当前位置」工具用的章内字符偏移。 */
  offset: number;
}

export type ReadingPositionState =
  | { kind: "loading" }
  | { kind: "restoring"; targetIndex: number; locator: string }
  | { kind: "following" };

export type ReadingPositionEvent =
  /** book 与 progress 查询均就绪；targetIndex 为 locator 解析出的 spine 索引，解析失败为 null。 */
  | { type: "SESSION_READY"; locator: string | null; targetIndex: number | null }
  | { type: "RESTORE_FINISHED"; result: AlignResult }
  | { type: "USER_NAVIGATED" }
  | { type: "CHAPTER_REQUESTED"; chapterId: string }
  | { type: "ANNOTATION_SCROLL"; locator: string }
  | { type: "TOP_SECTION_CHANGED"; position: ReadingPosition }
  | { type: "BOOK_CHANGED" };

export type ReadingPositionEffect =
  | { kind: "restoreToCfi"; locator: string; targetIndex: number }
  | { kind: "scrollToChapter"; chapterId: string }
  | { kind: "scrollToAnnotation"; locator: string }
  | { kind: "notifyTtsUserNavigation" }
  | { kind: "reportPosition"; position: ReadingPosition }
  | { kind: "persistProgress"; position: ReadingPosition };

export interface ReadingPositionTransition {
  next: ReadingPositionState;
  effects: ReadingPositionEffect[];
}

export function initialReadingPositionState(): ReadingPositionState {
  return { kind: "loading" };
}

export function reduceReadingPosition(
  state: ReadingPositionState,
  event: ReadingPositionEvent,
): ReadingPositionTransition {
  switch (event.type) {
    case "BOOK_CHANGED":
      return { next: { kind: "loading" }, effects: [] };

    case "SESSION_READY": {
      // 非 loading 时忽略：progress 缓存回写会重放此事件，不得触发二次恢复。
      if (state.kind !== "loading") return { next: state, effects: [] };
      if (event.locator == null || event.targetIndex == null)
        return { next: { kind: "following" }, effects: [] };
      return {
        next: { kind: "restoring", targetIndex: event.targetIndex, locator: event.locator },
        effects: [{ kind: "restoreToCfi", locator: event.locator, targetIndex: event.targetIndex }],
      };
    }

    case "RESTORE_FINISHED":
      // settled / timeout / cancelled 一律离开 restoring——恢复门没有吸收态。
      if (state.kind !== "restoring") return { next: state, effects: [] };
      return { next: { kind: "following" }, effects: [] };

    case "USER_NAVIGATED":
      if (state.kind === "loading") return { next: state, effects: [] };
      return { next: { kind: "following" }, effects: [] };

    case "CHAPTER_REQUESTED":
      // loading 期间忽略：首次 currentChapterId 可能是上次会话留在 store 里的旧值，
      // 让它跳转会抢在深处 initialIndex 之前挂载超长正文。
      if (state.kind === "loading") return { next: state, effects: [] };
      return {
        next: { kind: "following" },
        effects: [
          { kind: "notifyTtsUserNavigation" },
          { kind: "scrollToChapter", chapterId: event.chapterId },
        ],
      };

    case "ANNOTATION_SCROLL":
      if (state.kind === "loading") return { next: state, effects: [] };
      return {
        next: { kind: "following" },
        effects: [
          { kind: "notifyTtsUserNavigation" },
          { kind: "scrollToAnnotation", locator: event.locator },
        ],
      };

    case "TOP_SECTION_CHANGED":
      return {
        next: state,
        effects:
          state.kind === "following"
            ? [
                { kind: "reportPosition", position: event.position },
                { kind: "persistProgress", position: event.position },
              ]
            : [{ kind: "reportPosition", position: event.position }],
      };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/reading-position-machine.test.ts`
Expected: PASS，12 个用例全绿

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 无输出（通过）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/reader/reading-position-machine.ts src/renderer/reader/reading-position-machine.test.ts
git commit -m "feat(reader): add reading position state machine"
```

---

### Task 5: `EpubReader` 接入 L2 状态机

**Files:**

- Create: `src/renderer/reader/use-reading-position.ts`
- Modify: `src/renderer/reader/EpubReader.tsx`
- Delete: `src/renderer/reader/epub-progress-restore.ts`
- Delete: `src/renderer/reader/epub-progress-restore.test.ts`

**Interfaces:**

- Consumes: Task 4 的 `reduceReadingPosition` / `initialReadingPositionState` / `ReadingPosition` / `ReadingPositionEffect`；Task 2 的 `useMachine`；Task 3 的 `VirtualDocsHandle`
- Produces: `function useReadingPosition(args): { state, raise }` —— 供 `EpubReader` 消费

**背景：** 执行器承接原先散落在 `EpubReader` 里的五类动作：`scrollToCfi`、跳章、上报 store、存盘、通知 TTS。`EpubReader` 保留渲染、选区、标注装饰、链接处理，以及位置快照的计算（`topReadablePosition` / `anchorChapterIdAt` / `chapterTextOffsetBeforeIndex` —— 这些是 DOM 几何，留在组件里，算完再派发事件）。

被删掉的三个 ref：`restoredRef` → 状态离开 `loading`；`restoreTargetIndexRef` → `restoring` 分支的 `targetIndex`；`advanceRestoreGate` → `state.kind === "following"`。保留 `topChapterIdRef`（观测值缓存，非状态）与 `offsetFallbackWarnedRef`（日志去重）。

- [ ] **Step 1: 写执行器 hook**

创建 `src/renderer/reader/use-reading-position.ts`：

```ts
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMachine, type VirtualDocsHandle } from "@marginalia/virtual-docs";
import { createLogger } from "@renderer/logger";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { qk } from "../query/keys";
import type { EpubBook } from "./epub-book";
import {
  initialReadingPositionState,
  reduceReadingPosition,
  type ReadingPosition,
  type ReadingPositionEffect,
  type ReadingPositionEvent,
  type ReadingPositionState,
} from "./reading-position-machine";
import { ttsController } from "./tts/tts-controller";

const log = createLogger("epub");

const SAVE_DEBOUNCE_MS = 1000;

interface Args {
  bookId: string;
  book: EpubBook | null;
  persistProgress: boolean;
  vRef: React.RefObject<VirtualDocsHandle | null>;
  /** 把 CFI 解析成 section 内锚点元素；失败返回 null（退化为 section 顶）。 */
  resolveCfiElement: (cfi: string) => (doc: Document) => Element | null;
  /** 章 id → { index, anchor }；章不存在或 href 无法定位时返回 null。 */
  resolveChapterTarget: (chapterId: string) => { index: number; anchor: string | null } | null;
  /** 把位置快照写进 navigation store（当前章 / 阅读上下文 / 百分比）。 */
  reportPosition: (position: ReadingPosition) => void;
}

export function useReadingPosition({
  bookId,
  book,
  persistProgress,
  vRef,
  resolveCfiElement,
  resolveChapterTarget,
  reportPosition,
}: Args): {
  state: ReadingPositionState;
  raise: (event: ReadingPositionEvent) => void;
} {
  const qc = useQueryClient();
  const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<ReadingPositionState>(initialReadingPositionState());
  const raiseRef = useRef<((event: ReadingPositionEvent) => void) | null>(null);

  const runEffect = (effect: ReadingPositionEffect) => {
    switch (effect.kind) {
      case "restoreToCfi":
        void vRef.current
          ?.scrollToSectionElement(effect.targetIndex, resolveCfiElement(effect.locator), {
            owner: "restore",
          })
          .then((result) => raiseRef.current?.({ type: "RESTORE_FINISHED", result }));
        return;
      case "scrollToAnnotation": {
        const index = book?.indexOfCfi(effect.locator) ?? -1;
        if (index < 0) return;
        void vRef.current?.scrollToSectionElement(index, resolveCfiElement(effect.locator), {
          owner: "user",
        });
        return;
      }
      case "scrollToChapter": {
        const target = resolveChapterTarget(effect.chapterId);
        if (!target) return;
        if (target.anchor) void vRef.current?.scrollToAnchor(target.index, target.anchor);
        else vRef.current?.scrollToIndex(target.index);
        return;
      }
      case "notifyTtsUserNavigation":
        ttsController.notifyUserNavigation();
        return;
      case "reportPosition":
        setReadingPercent(effect.position.percent);
        reportPosition(effect.position);
        return;
      case "persistProgress": {
        if (!persistProgress || !effect.position.cfi) return;
        const { cfi, percent } = effect.position;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          // debounce 到期时重读状态：排队中的保存不得落在恢复期。
          if (stateRef.current.kind !== "following") return;
          void window.api.progress
            .save({ bookId, locator: cfi, percent })
            .catch((err: unknown) => log.warn("save progress failed", err));
          // 同步写入查询缓存：progress 查询 staleTime=Infinity，不写缓存的话重开书会读到
          // 首开时的旧值（通常是 null）→ initialIndex 永远 0 → 回到开头。
          qc.setQueryData(qk.progress(bookId), { locator: cfi });
        }, SAVE_DEBOUNCE_MS);
        return;
      }
    }
  };

  const [state, raise] = useMachine(
    reduceReadingPosition,
    initialReadingPositionState(),
    runEffect,
    {
      describeState: (s) => s.kind,
      onTransition: (r) => log.debug("reading position transition", r),
    },
  );
  stateRef.current = state;
  raiseRef.current = raise;

  // 换书：回到 loading 并丢弃在途存盘。
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    raise({ type: "BOOK_CHANGED" });
  }, [bookId, raise]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  return { state, raise };
}
```

- [ ] **Step 2: 改写 `EpubReader`**

在 `src/renderer/reader/EpubReader.tsx` 中：

删除 import：

```ts
import { advanceRestoreGate } from "./epub-progress-restore";
```

加入 import：

```ts
import { useReadingPosition } from "./use-reading-position";
import type { ReadingPosition } from "./reading-position-machine";
```

删除这三个 ref 声明：

```ts
const restoredRef = useRef(false);
const restoreTargetIndexRef = useRef<number | null>(null);
const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

「切书重置」effect 只保留观测值缓存的复位：

```ts
useEffect(() => {
  topChapterIdRef.current = null;
  topSectionIndexRef.current = 0;
  offsetFallbackWarnedRef.current = false;
}, [bookId]);
```

把 `scrollToCfi` 改成只负责「CFI → 元素解析器」的纯映射（滚动交给执行器）：

```ts
// cfiFromElement 生成的「指向元素」CFI 末段带 [id] 断言；epubjs toRange 对这类 point CFI 常返回
// null（"No startContainer found"），故取最后一个 [id] 断言作锚点元素 id 兜底。
const resolveCfiElement = (cfi: string) => (doc: Document) => {
  if (!book) return null;
  const idAssertion = [...cfi.matchAll(/\[([^\]]+)\]/g)].at(-1)?.[1] ?? null;
  // 先试 rangeFromCfi（标注的 range CFI 走这条精确路）；失败再用 [id] 断言 getElementById（进度恢复）。
  const node = book.rangeFromCfi(cfi, doc)?.startContainer ?? null;
  const fromRange = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  return fromRange ?? (idAssertion ? doc.getElementById(idAssertion) : null);
};

const resolveChapterTarget = (chapterId: string) => {
  const ch = chapters.find((c) => c.id === chapterId);
  if (!ch || !book) return null;
  const index = book.indexOfHref(ch.href);
  return index < 0 ? null : { index, anchor: ch.anchor ?? null };
};

const reportPosition = (position: ReadingPosition) => {
  if (position.chapterId == null) return;
  setReadingContext({
    format: "epub",
    chapterId: position.chapterId,
    chapterTitle: position.chapterTitle,
    offset: position.offset,
    maxChars: CURRENT_EPUB_READ_CHARS,
    spineIndex: position.index,
    locator: position.cfi,
  });
  topChapterIdRef.current = position.chapterId;
  if (position.chapterId !== currentChapterId) setCurrentChapter(position.chapterId);
};

const { raise } = useReadingPosition({
  bookId,
  book,
  persistProgress,
  vRef,
  resolveCfiElement,
  resolveChapterTarget,
  reportPosition,
});
```

用事件派发替换三个 effect。恢复 effect（原 `useEffect(..., [book, progress.isLoading])`）替换为：

```ts
// 恢复初始位置：进度 locator → section index（initialIndex 让 VirtualDocs 首挂即落在正确 section），
// 再由状态机发起锚点级精确定位（initialIndex 只到 section 顶，对「一个 section 几十章」的书等于回开头）。
useEffect(() => {
  if (!book || progress.isLoading) return;
  const locator = progress.data?.locator ?? null;
  const target = locator == null ? -1 : book.indexOfCfi(locator);
  raise({ type: "SESSION_READY", locator, targetIndex: target >= 0 ? target : null });
}, [book, progress.isLoading, progress.data?.locator, raise]);
```

跳章 effect 替换为：

```ts
// 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到对应 spine index（锚点级）。
useEffect(() => {
  if (currentChapterId == null) return;
  if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
  raise({ type: "CHAPTER_REQUESTED", chapterId: currentChapterId });
}, [currentChapterId, raise]);
```

标注跳转 effect 替换为：

```ts
// 侧栏列表点击 → 精确滚到该标注（锚点级：CFI 解析回元素，不再只到 section 顶）。
useEffect(() => {
  if (!scrollCommand) return;
  raise({ type: "ANNOTATION_SCROLL", locator: scrollCommand.locator });
}, [scrollCommand, raise]);
```

TTS attach 的 `scrollToSection` 去掉 ref 清理（所有权转移由 L3 的 `JUMP_REQUESTED` 处理）：

```ts
scrollToSection: (i) => vRef.current?.scrollToIndex(i),
```

`onTopSectionChange` 尾部（从 `const { cfi, textOffset } = topReadablePosition(index);` 起）替换为：

```ts
const { cfi, textOffset } = topReadablePosition(index);
if (textOffset == null && book.textLengthAtIndex(index) > 0 && !offsetFallbackWarnedRef.current) {
  offsetFallbackWarnedRef.current = true;
  log.warn(`text offset unavailable; using section scroll ratio: ${index}`);
}
const percent = epubPercent(index, textOffset, book.textLengths, meta.scrollRatio);
// 锚点章 = 整 spine 文件里的一小片（正文从锚点切到下一锚点），整章一次 readChapterText 即读全 →
// offset 从 0 起。section 相对 offset（= 在整个大文件里的字符位置）对锚点章无意义：会远超章长、
// 取到空文本，使「读我当前位置」的 AI 工具拿不到内容。无锚点的整文件章仍用 section 相对 offset。
const sectionLength = book.chapterTextLengthAtIndex(index);
const offset =
  chId == null
    ? 0
    : ch?.anchor
      ? 0
      : chapterTextOffsetBeforeIndex(chId, index) + Math.floor(sectionLength * meta.scrollRatio);
raise({
  type: "TOP_SECTION_CHANGED",
  position: {
    index,
    scrollRatio: meta.scrollRatio,
    cfi,
    percent,
    chapterId: chId,
    chapterTitle: ch?.title ?? null,
    offset,
  },
});
```

同时删除 `onTopSectionChange` 开头的这两行（恢复门已由状态机接管）：

```ts
const restoreGate = advanceRestoreGate(restoreTargetIndexRef.current, index);
restoreTargetIndexRef.current = restoreGate.target;
```

`VirtualDocs` 的 `onUserNavigation` 改为派发事件，并新增 `onTransition`：

```ts
onUserNavigation={() => raise({ type: "USER_NAVIGATED" })}
onTransition={(r) => log.debug("viewport transition", r)}
```

`onInternalLink` 中删除 `restoreTargetIndexRef.current = null;` 一行（`scrollToAnchor` / `scrollToIndex` 已在 L3 内表达所有权转移）。

删除 `setReadingPercent` 的订阅（它已移进执行器，留在组件里会成为未使用变量、被 oxlint 拦下）：

```ts
const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
```

渲染守卫保持不变（`if (!book || progress.isLoading) return <载入中/>`）。`useReadingPosition` 返回的 `state` 暂不参与渲染（它的价值在迁移日志），故只解构 `raise`。

- [ ] **Step 3: 删除旧模块**

```bash
git rm src/renderer/reader/epub-progress-restore.ts src/renderer/reader/epub-progress-restore.test.ts
```

- [ ] **Step 4: 类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 无输出；test 全绿

- [ ] **Step 5: 手测（真书）**

Run: `pnpm dev`。逐项确认并观察 DevTools console 的迁移日志：

1. 冷启恢复到上次位置 → 日志出现 `loading → restoring → following`；
2. 恢复中滚滚轮 → 日志出现 `RESTORE_FINISHED result=cancelled`，位置不被拽回；
3. 关书重开 → 位置正确（证明 `following` 期间存盘生效）；
4. 侧栏跳章、点标注、TTS 起读跳转均到位。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/reader/use-reading-position.ts src/renderer/reader/EpubReader.tsx
git commit -m "refactor(reader): drive epub reading position by explicit state machine"
```

---

### Task 6: 收口滚动容器的全局选择器耦合

**Files:**

- Modify: `src/renderer/reader/tts/tts-controller.ts`
- Modify: `src/renderer/reader/EpubReader.tsx`

**Interfaces:**

- Consumes: Task 3 的 `VirtualDocsHandle.getScrollerElement()`
- Produces: `ReaderTtsContext` 新增字段 `getScroller: () => Element | null`

**背景：** `EpubReader.tsx` 与 `tts-controller.ts` 都用 `document.querySelector(".no-scrollbar")` 取滚动容器。当前 DOM 顺序下结果正确（`NoteModal` / `NoteHoverCard` 同样带该类，但排在 reader 之后），但只要浮层改用 portal 挂到 body 前部、或 reader 上方新增滚动容器，`targetInDoc` 就会算错并把错误 CFI 写进进度。改为从 `VirtualDocs` 注入真实 scroller。

- [ ] **Step 1: 给 `ReaderTtsContext` 加注入字段**

在 `src/renderer/reader/tts/tts-controller.ts` 中把接口改为：

```ts
/** EpubReader attach 进来的上下文（卸载时 detach）。 */
export interface ReaderTtsContext {
  sectionCount: number;
  getTopSectionIndex: () => number;
  scrollToSection: (index: number) => void;
  /** 真实滚动容器；由 VirtualDocs 提供，避免全局类选择器耦合。 */
  getScroller: () => Element | null;
}
```

删除模块级函数：

```ts
function scrollerEl(): Element | null {
  return document.querySelector(".no-scrollbar");
}
```

`firstVisibleParagraph` 改为收 scroller 作参数：

```ts
/** 视口内第一个可见段；无（图片页等）→ 0（spec §6：从该 section 第一段起）。 */
function firstVisibleParagraph(
  paras: TtsParagraph[],
  frame: HTMLIFrameElement,
  scroller: Element | null,
): number {
  if (!scroller) return 0;
  const frameTop = frame.getBoundingClientRect().top;
  const view = scroller.getBoundingClientRect();
  for (let i = 0; i < paras.length; i++) {
    const r = paras[i]!.element.getBoundingClientRect(); // iframe 不内滚：主坐标 = frameTop + r
    if (frameTop + r.bottom > view.top + 4 && frameTop + r.top < view.bottom) return i;
  }
  return 0;
}
```

`scrollToParagraph` 内的 `const scroller = scrollerEl();` 改为 `const scroller = this.ctx?.getScroller() ?? null;`。

`firstVisibleParagraph` 的调用点补上第三个实参 `this.ctx?.getScroller() ?? null`（用 `grep -n "firstVisibleParagraph" src/renderer/reader/tts/tts-controller.ts` 定位调用点）。

- [ ] **Step 2: `EpubReader` 提供 scroller 并去掉自己的全局查询**

在 `src/renderer/reader/EpubReader.tsx` 的 TTS attach 中补一行：

```ts
ttsController.attach({
  sectionCount: book.count,
  getTopSectionIndex: () => topSectionIndexRef.current,
  scrollToSection: (i) => vRef.current?.scrollToIndex(i),
  getScroller: () => vRef.current?.getScrollerElement() ?? null,
});
```

`topReadablePosition` 内的：

```ts
const scroller = document.querySelector(".no-scrollbar");
```

改为：

```ts
const scroller = vRef.current?.getScrollerElement() ?? null;
```

- [ ] **Step 3: 确认无遗漏**

Run: `grep -rn "no-scrollbar" src/renderer/reader`
Expected: 只剩下 `className` 用法（`EpubReader.tsx` 的 `<VirtualDocs className="no-scrollbar">`、`PdfReader.tsx`、`NoteHoverCard.tsx`、`NoteModal.tsx`），不再有 `querySelector`

- [ ] **Step 4: 类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 无输出；test 全绿

- [ ] **Step 5: 手测 TTS**

Run: `pnpm dev`。打开一本 ePub，点顶栏朗读按钮：

1. 从视口内第一段起读（不是从 section 开头）；
2. 朗读推进时自动滚动跟随；
3. 手动滚动后跟随挂起，停止朗读正常。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/reader/tts/tts-controller.ts src/renderer/reader/EpubReader.tsx
git commit -m "refactor(reader): inject scroller instead of querying by class"
```

---

### Task 7: 收尾（changeset + 全量验证）

**Files:**

- Create: `.changeset/<自动生成的名字>.md`

**Interfaces:**

- Consumes: 前六个 task 的全部产出
- Produces: 无

- [ ] **Step 1: 全量验证**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:all
```

Expected: 四项全过。若 `format:check` 失败，跑 `pnpm format` 后重新提交。

- [ ] **Step 2: 确认删除的文件确实没有残留引用**

```bash
grep -rn "scroll-convergence\|advanceRestoreGate\|epub-progress-restore" src packages --include=*.ts --include=*.tsx
```

Expected: 无输出

- [ ] **Step 3: 写 changeset**

Run: `pnpm changeset`

选择 patch 级别，正文（英文，面向用户）：

```
Fix reading progress silently not being saved after a slow position restore times out.
```

- [ ] **Step 4: 提交**

```bash
git add .changeset
git commit -m "chore: add changeset for reading position state machine refactor"
```

- [ ] **Step 5: 走收尾流程**

使用 `superpowers:finishing-a-development-branch` skill 决定合并方式，并用 `kanban` skill 检查有无可挪列 / close 的 issue。

---

## 附：验证矩阵

重构完成后，用下表逐项手测（真书，长 ePub 优先）。任一项失败时，先看 DevTools console 的迁移日志定位是哪台机的哪次迁移。

| 场景                     | 期望                                   | 相关迁移                                                        |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| 冷启开一本读到深处的书   | 直接落在上次位置，不闪开头             | `loading → restoring → following`                               |
| 恢复过程中滚滚轮         | 立刻夺回控制权，不被拽回               | `RESTORE_FINISHED result=cancelled`；L3 `aligning → userOwned`  |
| 恢复超时（超长 section） | 30 秒后仍进入 following，此后正常存盘  | `RESTORE_FINISHED result=timeout`                               |
| 读一会儿关书重开         | 回到关书时的位置                       | `persistProgress` 出现在 effects 中                             |
| 侧栏点章                 | 跳到该章（锚点章精确到锚点）           | L2 `CHAPTER_REQUESTED`；L3 `JUMP_REQUESTED` / `ALIGN_REQUESTED` |
| 点标注列表条目           | 精确跳到该标注                         | L2 `ANNOTATION_SCROLL`                                          |
| 正文内点站内链接         | 跳到目标锚点                           | L3 `ALIGN_REQUESTED owner=user`                                 |
| TTS 起读 + 跨章          | 从视口首段起读，自动跟随               | L3 `JUMP_REQUESTED`                                             |
| 切换明暗主题             | 位置不变                               | 若仍跳，即坐实根因在 L4 高度测量机（本次范围外）                |
| 换书                     | 新书正确恢复，旧书的在途存盘不写到新书 | `BOOK_CHANGED → loading`                                        |
