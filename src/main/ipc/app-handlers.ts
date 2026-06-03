import { app, ipcMain } from "electron";
import { z } from "zod";
import { IPC, pingInput, type AppGetInfoResult, type PingResult } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-service";
import { handle } from "@main/ipc/registry";

export function registerAppHandlers(): void {
  handle<{ msg: string }, PingResult>(IPC.ping, pingInput, ping);

  handle<void, AppGetInfoResult>(IPC.appGetInfo, z.void(), () =>
    getAppInfo(getDb(), app.getVersion()),
  );

  // 同步通道：preload 首帧前取系统 locale（供 i18n init 决定默认语言）。
  // 故意绕开异步 registry.handle；app.getLocale() 在极少数情况下可能抛，整体兜底返回 "en"，绝不让 i18n init 崩。
  ipcMain.on(IPC.appGetLocaleSync, (e) => {
    try {
      e.returnValue = app.getLocale();
    } catch {
      e.returnValue = "en"; // 安全回退：取系统 locale 失败时默认英文
    }
  });
}
