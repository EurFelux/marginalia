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
