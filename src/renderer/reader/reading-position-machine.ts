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
  /** 视口顶那个块级元素首字符的 range CFI；section 尚未渲染时未知（null）。 */
  cfi: string | null;
  /** 全书阅读进度，0–1。 */
  percent: number;
  chapterId: string | null;
  chapterTitle: string | null;
  /** 「读我当前位置」工具用的章内字符偏移。 */
  offset: number;
}

/** 重排后要回到的段落：最近一次视口顶位置的 CFI 与 spine 索引。 */
export interface ReadingAnchor {
  cfi: string;
  index: number;
}

export type ReadingPositionState =
  | { kind: "loading" }
  | { kind: "restoring"; targetIndex: number; locator: string }
  /** last = 重排时要对齐回去的锚点；跳转后、首个位置上报前为 null（此时重排不处理）。 */
  | { kind: "following"; last: ReadingAnchor | null };

export type ReadingPositionEvent =
  /** book 与 progress 查询均就绪；targetIndex 为 locator 解析出的 spine 索引，解析失败为 null。 */
  | { type: "SESSION_READY"; locator: string | null; targetIndex: number | null }
  | { type: "RESTORE_FINISHED"; result: AlignResult }
  | { type: "USER_NAVIGATED" }
  | { type: "CHAPTER_REQUESTED"; chapterId: string }
  | { type: "ANNOTATION_SCROLL"; locator: string }
  /** 搜索结果跳转：href 所在 spine 文件内第 occurrence 个 query 命中。 */
  | { type: "SEARCH_HIT_REQUESTED"; href: string; occurrence: number; query: string }
  | { type: "TOP_SECTION_CHANGED"; position: ReadingPosition }
  /** 正文重排（排版偏好变化，或栏宽变化且确实重排）：视口内容已离开像素位置对应的段落。 */
  | { type: "REFLOWED" }
  | { type: "BOOK_CHANGED" };

export type ReadingPositionEffect =
  | { kind: "restoreToCfi"; locator: string; targetIndex: number }
  | { kind: "scrollToChapter"; chapterId: string }
  | { kind: "scrollToAnnotation"; locator: string }
  | { kind: "scrollToSearchHit"; href: string; occurrence: number; query: string }
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

/** 跳转 / 无进度开书进入 following：视口去了别处，不沿用旧锚点。 */
const FOLLOWING_UNANCHORED: ReadingPositionState = { kind: "following", last: null };

/** 恢复（含重排后的重新对齐）结束：视口就在恢复目标处，以它为锚。 */
function followingAt(state: { targetIndex: number; locator: string }): ReadingPositionState {
  return { kind: "following", last: { cfi: state.locator, index: state.targetIndex } };
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
        return { next: FOLLOWING_UNANCHORED, effects: [] };
      return {
        next: { kind: "restoring", targetIndex: event.targetIndex, locator: event.locator },
        effects: [{ kind: "restoreToCfi", locator: event.locator, targetIndex: event.targetIndex }],
      };
    }

    case "RESTORE_FINISHED":
      // settled / timeout / cancelled 一律离开 restoring——恢复门没有吸收态。
      if (state.kind !== "restoring") return { next: state, effects: [] };
      return { next: followingAt(state), effects: [] };

    case "USER_NAVIGATED":
      if (state.kind !== "restoring") return { next: state, effects: [] };
      return { next: followingAt(state), effects: [] };

    case "CHAPTER_REQUESTED":
      // loading 期间忽略：首次 currentChapterId 可能是上次会话留在 store 里的旧值，
      // 让它跳转会抢在深处 initialIndex 之前挂载超长正文。
      if (state.kind === "loading") return { next: state, effects: [] };
      return {
        next: FOLLOWING_UNANCHORED,
        effects: [
          { kind: "notifyTtsUserNavigation" },
          { kind: "scrollToChapter", chapterId: event.chapterId },
        ],
      };

    case "ANNOTATION_SCROLL":
      if (state.kind === "loading") return { next: state, effects: [] };
      return {
        next: FOLLOWING_UNANCHORED,
        effects: [
          { kind: "notifyTtsUserNavigation" },
          { kind: "scrollToAnnotation", locator: event.locator },
        ],
      };

    case "SEARCH_HIT_REQUESTED": {
      if (state.kind === "loading") return { next: state, effects: [] };
      const { href, occurrence, query } = event;
      return {
        next: FOLLOWING_UNANCHORED,
        effects: [
          { kind: "notifyTtsUserNavigation" },
          { kind: "scrollToSearchHit", href, occurrence, query },
        ],
      };
    }

    case "TOP_SECTION_CHANGED": {
      if (state.kind !== "following")
        return { next: state, effects: [{ kind: "reportPosition", position: event.position }] };
      const { cfi, index } = event.position;
      const moved = cfi != null && (state.last?.cfi !== cfi || state.last.index !== index);
      return {
        next: moved ? { kind: "following", last: { cfi, index } } : state,
        effects: [
          { kind: "reportPosition", position: event.position },
          { kind: "persistProgress", position: event.position },
        ],
      };
    }

    case "REFLOWED":
      // restoring 中不处理：进行中的收敛逐 tick 按目标元素的当前位置重测，本身能适应重排；
      // 重发 restoreToCfi 反而会让上一轮以 cancelled 收场、把 restoring 提前推回 following。
      if (state.kind !== "following" || state.last == null) return { next: state, effects: [] };
      return {
        next: { kind: "restoring", targetIndex: state.last.index, locator: state.last.cfi },
        effects: [{ kind: "restoreToCfi", locator: state.last.cfi, targetIndex: state.last.index }],
      };
  }
}
