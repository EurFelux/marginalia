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
      case "restoreToCfi": {
        const handle = vRef.current;
        // handle 缺失时必须自己发终结事件：可选链短路会让 RESTORE_FINISHED 永不到达，
        // 状态永久卡在 restoring、进度从此不再保存——正是本次要消灭的那类缺陷。
        if (!handle) {
          raiseRef.current?.({ type: "RESTORE_FINISHED", result: "cancelled" });
          return;
        }
        // owner: "restore" 表示这次定位由系统发起，不计作用户导航——据此保持顶部 overscan 为 0，
        // 避免上方 section 的迟到测高把恢复目标推走。用户主动跳转则传 "user"。
        void handle
          .scrollToSectionElement(effect.targetIndex, resolveCfiElement(effect.locator), {
            owner: "restore",
          })
          .then((result) => raiseRef.current?.({ type: "RESTORE_FINISHED", result }));
        return;
      }
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
