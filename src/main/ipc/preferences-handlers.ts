import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import { setPreferenceInput, type SetPreferenceInput } from "@shared/preferences";
import { getDb } from "@main/db/instance";
import { getAllPreferences, setPreference } from "@main/preferences/repository";
import { handle } from "@main/ipc/registry";

export function registerPreferenceHandlers(): void {
  // 读：同步 sendSync 通道——preload 在首帧前取整份快照（挂 .dark + hydrate）。
  // 故意绕开异步 registry.handle；getDb() 在 DB 未就绪时可能抛，整体兜底返回 {}，绝不让首帧读崩。
  ipcMain.on(IPC.preferencesGetAllSync, (e) => {
    try {
      e.returnValue = getAllPreferences(getDb());
    } catch {
      e.returnValue = {};
    }
  });

  // 写：运行时变更落盘（异步 invoke，fire-and-forget）。
  handle<SetPreferenceInput, void>(IPC.preferencesSet, setPreferenceInput, (input) => {
    // 按 key 判别窄化，使 (key, value) 关联类型传给泛型 setPreference 时成立（input 已经 Zod 校验）。
    switch (input.key) {
      case "readerPrefs":
        return setPreference(getDb(), input.key, input.value);
      case "lastHighlightStyle":
        return setPreference(getDb(), input.key, input.value);
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
      case "colorMode":
        return setPreference(getDb(), input.key, input.value);
      case "language":
        return setPreference(getDb(), input.key, input.value);
    }
  });
}
