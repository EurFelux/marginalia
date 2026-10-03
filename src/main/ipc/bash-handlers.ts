import { stat } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import type { BashWorkdirInfo } from "@shared/bash";
import { appService } from "@main/app";
import { getDb } from "@main/db/instance";
import { bind, register, type Binding } from "@main/ipc/registry";
import { getPreference } from "@main/preferences/repository";
import { resolveWorkdir } from "@main/shell/workdir";

const customWorkdir = () => getPreference(getDb(), "bashWorkdir") ?? null;

export const bashBindings: Binding[] = [
  bind(C.bashWorkdirInfo, async (): Promise<BashWorkdirInfo> => {
    const custom = customWorkdir();
    const path = custom ?? appService.getPath("workspaceDir");
    const exists = await stat(path)
      .then((s) => s.isDirectory())
      .catch(() => false);
    return { path, isDefault: custom === null, exists };
  }),

  bind(C.bashPickWorkdir, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ["openDirectory" as const, "createDirectory" as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
  }),

  // 默认工作区不存在时先创建；自定义目录不存在则抛错（由设置页提示用户重选）。
  bind(C.bashOpenWorkdir, async () => {
    await appService.openFolder(
      await resolveWorkdir(customWorkdir(), appService.getPath("workspaceDir")),
    );
  }),
];

export function registerBashHandlers(): void {
  register(bashBindings);
}
