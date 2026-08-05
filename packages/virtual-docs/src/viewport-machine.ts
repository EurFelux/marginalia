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

/**
 * 深处冷启且用户尚未导航过时禁用顶部预挂载：上方 section 的迟到测高会推走恢复目标。
 * 一旦发生用户级导航即永久恢复双向 overscan。
 */
export function overscanTop(state: ViewportState, initialIndex: number, fullTop: number): number {
  return initialIndex > 0 && !state.everUserNavigated ? 0 : fullTop;
}
