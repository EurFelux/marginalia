import { useEffect } from "react";
import { createLogger } from "@renderer/logger";
import { useSettingsStore } from "@renderer/store/settings-store";

const log = createLogger("stats");

/** 进/出 reader 时向主进程上报阅读状态；设置弹窗遮挡 reader 时上报 null（暂停）。
 * 焦点/电源由主进程观测，此处只管「是否在 reader 且未被设置弹窗遮挡」。 */
export function useReadingClock(bookId: string | null): void {
  const settingsOpen = useSettingsStore((s) => s.open);
  useEffect(() => {
    const target = bookId != null && !settingsOpen ? bookId : null;
    void window.api.stats
      .readingState(target ? { status: "active", bookId: target } : { status: "idle" })
      .catch((err: unknown) => log.warn("reading-state report failed", err));
  }, [bookId, settingsOpen]);
  // 卸载（离开 reader）时复位 null。
  useEffect(
    () => () => {
      void window.api.stats
        .readingState({ status: "idle" })
        .catch((err: unknown) => log.warn("reading-state cleanup failed", err));
    },
    [],
  );
}
