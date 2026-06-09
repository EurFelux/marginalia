import { app, powerMonitor, type BrowserWindow } from "electron";
import { getDb } from "@main/db/instance";
import { createReadingClock, type ReadingClock } from "@main/stats/clock";
import { localDayKey } from "@main/stats/day-key";
import { addSeconds } from "@main/stats/reading-daily";
import { createLogger } from "@main/logger";

const log = createLogger("stats");

/** flush 周期：崩溃最多丢一个间隔；跨午夜由按 atMs 重算 day 自然切分。 */
const FLUSH_INTERVAL_MS = 60_000;

let clock: ReadingClock | null = null;

/** 供 IPC handler 调用的时钟句柄。 */
export function getReadingClock(): ReadingClock {
  if (!clock) throw new Error("reading clock not initialized");
  return clock;
}

/** app.ready 调一次：建时钟 + 接 powerMonitor + 周期 flush + 退出收尾。 */
export function initReadingClock(): void {
  if (clock) return;
  clock = createReadingClock({
    now: () => Date.now(),
    commit: (bookId, atMs, seconds) => {
      try {
        addSeconds(getDb(), bookId, localDayKey(atMs), seconds);
      } catch (err) {
        log.warn("commit reading time failed", err);
      }
    },
  });
  clock.setAwake(true);
  powerMonitor.on("suspend", () => clock?.setAwake(false));
  powerMonitor.on("resume", () => clock?.setAwake(true));
  powerMonitor.on("lock-screen", () => clock?.setAwake(false)); // macOS/Windows；缺失时 suspend 兜底
  powerMonitor.on("unlock-screen", () => clock?.setAwake(true));
  const interval = setInterval(() => clock?.tick(), FLUSH_INTERVAL_MS);
  app.on("before-quit", () => {
    clearInterval(interval);
    clock?.tick();
  });
}

/** createWindow 调：绑定窗口焦点；reload/closed 复位 currentBook。 */
export function bindWindowToClock(win: BrowserWindow): void {
  const c = getReadingClock();
  c.setFocused(win.isFocused());
  win.on("focus", () => c.setFocused(true));
  win.on("blur", () => c.setFocused(false));
  win.webContents.on("did-finish-load", () => c.setReadingBook(null));
  win.on("closed", () => c.setReadingBook(null));
}
