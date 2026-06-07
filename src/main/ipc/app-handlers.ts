import { app, ipcMain } from "electron";
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-info";
import { bind, register, type Binding } from "@main/ipc/registry";

export const appBindings: Binding[] = [
  bind(C.ping, ping),
  bind(C.appGetInfo, () => getAppInfo(getDb(), app.getVersion())),
];

export function registerAppHandlers(): void {
  register(appBindings);

  // 同步通道：preload 首帧前取系统 locale（供 i18n init 决定默认语言）。
  // 故意绕开异步 register；app.getLocale() 在极少数情况下可能抛，整体兜底返回 "en"，绝不让 i18n init 崩。
  ipcMain.on(C.appGetLocaleSync.channel, (e) => {
    try {
      e.returnValue = app.getLocale();
    } catch {
      e.returnValue = "en"; // 安全回退：取系统 locale 失败时默认英文
    }
  });
}
