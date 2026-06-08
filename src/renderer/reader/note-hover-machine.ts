/** 锚点视口坐标矩形（与 virtual-docs ViewportRect、SelectionInfo.rect 同形状，故跨层结构兼容）。 */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HoverState {
  /** 当前命中的标注 id；无命中为 null。 */
  annoId: string | null;
  /** 卡片定位锚点（视口坐标）。 */
  anchorRect: AnchorRect | null;
  /** 卡片是否展开。 */
  open: boolean;
}

/** 给消费方（store）的定时器指令：start＝起关闭窗口，cancel＝撤销待关，none＝不动。 */
export type TimerCmd = "start" | "cancel" | "none";

export type HoverEvent =
  | { type: "enterHighlight"; annoId: string; rect: AnchorRect }
  | { type: "leaveHighlight" }
  | { type: "enterCard" }
  | { type: "leaveCard" }
  | { type: "closeNow" };

export const HOVER_INITIAL: HoverState = { annoId: null, anchorRect: null, open: false };

export interface HoverResult {
  next: HoverState;
  timer: TimerCmd;
}

/**
 * 安全 hover 状态机（纯函数）。副作用（真实 setTimeout）由 store 按 `timer` 指令执行。
 * 「可移入」靠 leave→start（150ms 窗口）、enter(card/highlight)→cancel 协调。
 */
export function reduceHover(state: HoverState, event: HoverEvent): HoverResult {
  switch (event.type) {
    case "enterHighlight": {
      // 幂等：同 id 已展开时不重置 open（仅更新锚点，跟随当前片段），避免多片段间闪烁。
      if (state.open && state.annoId === event.annoId) {
        return { next: { ...state, anchorRect: event.rect }, timer: "cancel" };
      }
      return {
        next: { annoId: event.annoId, anchorRect: event.rect, open: true },
        timer: "cancel",
      };
    }
    case "leaveHighlight":
      // 离开高亮：起关闭窗口（给鼠标移到卡片的时间），状态暂不变。
      return { next: state, timer: "start" };
    case "enterCard":
      return { next: state, timer: "cancel" };
    case "leaveCard":
      return { next: state, timer: "start" };
    case "closeNow":
      return { next: HOVER_INITIAL, timer: "cancel" };
  }
}
