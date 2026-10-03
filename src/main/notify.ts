// src/main/notify.ts —— main→renderer 推送的唯一 Electron 触点（通知：spec 2026-06-16 §4.3；工具审批：spec 2026-10-03 §5.6）。
import { BrowserWindow } from "electron";
import { C } from "@shared/ipc";
import type { AppNotification } from "@shared/chat";
import type { AskPort } from "@main/permissions/gate";

/** 向所有窗口广播（单窗口 app 即发给那一个）；窗口已销毁则跳过。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function notifyRenderer(n: AppNotification): void {
  broadcast(C.appNotify.channel, n);
}

/** 工具审批的询问端口：挂起请求 / 撤销都推给渲染层（spec 2026-10-03 §5.6）。 */
export const permissionAskPort: AskPort = {
  request: (request) => broadcast(C.permissionRequest.channel, request),
  cancel: (cancel) => broadcast(C.permissionCancel.channel, cancel),
};
