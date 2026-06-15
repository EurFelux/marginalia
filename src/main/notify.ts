// src/main/notify.ts —— main→renderer 通知的唯一 Electron 触点（spec 2026-06-16 §4.3）。
import { BrowserWindow } from "electron";
import { C } from "@shared/ipc";
import type { AppNotification } from "@shared/chat";

/** 向所有窗口广播一条通知（单窗口 app 即发给那一个）；窗口已销毁则跳过。 */
export function notifyRenderer(n: AppNotification): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(C.appNotify.channel, n);
  }
}
