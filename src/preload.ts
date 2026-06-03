import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { C } from "@shared/ipc";
import type { PreferencesSnapshot } from "@shared/preferences";
import { createApi } from "./preload-api";

// 首帧前同步读整份偏好快照（read 仅启动一次）：供渲染层同步初始化 theme-store（挂 .dark）+ hydrate。
// 注意：挂 .dark 的 DOM 操作放在 renderer 入口（src/renderer.tsx），不在此处——sandbox preload 模块求值时
// document.documentElement 尚为 null，在此 toggle 会抛错并令整个 preload（含 contextBridge 暴露）失败。
const prefsSnapshot = ipcRenderer.sendSync(C.preferencesGetAllSync.channel) as PreferencesSnapshot;
const appLocale = ipcRenderer.sendSync(C.appGetLocaleSync.channel) as string;

const api = createApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  prefsSnapshot,
  appLocale,
});

contextBridge.exposeInMainWorld("api", api);

export type { RendererApi } from "./preload-api";
