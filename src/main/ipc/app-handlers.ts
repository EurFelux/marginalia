import { app, ipcMain, net, shell } from "electron";
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-info";
import { bind, register, type Binding } from "@main/ipc/registry";
import { isAllowedExternalUrl } from "@main/app/external-url";
import { checkForUpdate } from "@main/app/update-check";
import { createLogger } from "@main/logger";

const log = createLogger("app");

// net.fetch 走系统代理（同 settings-handlers）；annotated binding 免去结果 cast。
const netFetch: typeof fetch = (url, init) => net.fetch(url as string, init);

export const appBindings: Binding[] = [
  bind(C.ping, ping),
  bind(C.appGetInfo, () => getAppInfo(getDb(), app.getVersion())),
  bind(C.appOpenExternal, (input) => {
    if (!isAllowedExternalUrl(input.url)) {
      log.warn(`refused to open external url with disallowed protocol: ${input.url}`);
      return;
    }
    void shell.openExternal(input.url);
  }),
  bind(C.appCheckUpdate, () => checkForUpdate(app.getVersion(), netFetch)),
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
