import { create } from "zustand";
import {
  reduceHover,
  HOVER_INITIAL,
  type HoverState,
  type HoverEvent,
  type AnchorRect,
} from "@renderer/reader/note-hover-machine";

/** 离开高亮/卡片后关闭的宽限窗口（ms），对齐 hover-card.tsx 现有 closeDelay。 */
const CLOSE_DELAY_MS = 150;

interface NoteHoverActions {
  /** 命中适配上报：悬停到带笔记的高亮。 */
  hoverHighlight: (annoId: string, rect: AnchorRect) => void;
  /** 命中适配上报：离开高亮。 */
  leaveHighlight: () => void;
  /** 卡片自身：鼠标移入（取消待关）。 */
  enterCard: () => void;
  /** 卡片自身：鼠标移出（起待关）。 */
  leaveCard: () => void;
  /** 立即关闭（滚动 / 点编辑 / Esc / 点外部）。 */
  closeNow: () => void;
}

// 模块级单定时器：store 是单例，关闭窗口全局唯一。
let closeTimer: ReturnType<typeof setTimeout> | null = null;
function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export const useNoteHoverStore = create<HoverState & NoteHoverActions>((set, get) => {
  const dispatch = (event: HoverEvent) => {
    const { next, timer } = reduceHover(
      { annoId: get().annoId, anchorRect: get().anchorRect, open: get().open },
      event,
    );
    set(next);
    if (timer === "cancel") {
      clearCloseTimer();
    } else if (timer === "start") {
      clearCloseTimer();
      closeTimer = setTimeout(() => {
        closeTimer = null;
        set(HOVER_INITIAL);
      }, CLOSE_DELAY_MS);
    }
  };
  return {
    ...HOVER_INITIAL,
    hoverHighlight: (annoId, rect) => dispatch({ type: "enterHighlight", annoId, rect }),
    leaveHighlight: () => dispatch({ type: "leaveHighlight" }),
    enterCard: () => dispatch({ type: "enterCard" }),
    leaveCard: () => dispatch({ type: "leaveCard" }),
    closeNow: () => {
      clearCloseTimer();
      set(HOVER_INITIAL);
    },
  };
});
