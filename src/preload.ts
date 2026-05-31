import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppGetInfoResult, type PingInput, type PingResult } from "@shared/ipc";

const api = {
  app: {
    getInfo: (): Promise<AppGetInfoResult> => ipcRenderer.invoke(IPC.appGetInfo),
  },
  ping: (input: PingInput): Promise<PingResult> => ipcRenderer.invoke(IPC.ping, input),
};

contextBridge.exposeInMainWorld("api", api);

export type RendererApi = typeof api;
