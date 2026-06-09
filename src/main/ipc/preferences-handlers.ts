import { ipcMain } from "electron";
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAllPreferences, setPreference } from "@main/preferences/repository";
import { bind, register, type Binding } from "@main/ipc/registry";
import { setMainLanguage } from "@main/i18n";

export const preferencesBindings: Binding[] = [
  // 写：运行时变更落盘（异步 invoke，fire-and-forget）。
  bind(C.preferencesSet, (input) => {
    // 按 key 判别窄化，使 (key, value) 关联类型传给泛型 setPreference 时成立（input 已经 Zod 校验）。
    switch (input.key) {
      case "readerPrefs":
        return setPreference(getDb(), input.key, input.value);
      case "lastHighlightStyle":
        return setPreference(getDb(), input.key, input.value);
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
      case "onboardingDismissed":
        return setPreference(getDb(), input.key, input.value);
      case "colorMode":
        return setPreference(getDb(), input.key, input.value);
      case "language":
        setMainLanguage(input.value);
        return setPreference(getDb(), input.key, input.value);
      case "readerLayout":
        return setPreference(getDb(), input.key, input.value);
      case "summaryModel":
        return setPreference(getDb(), input.key, input.value);
      case "pdfZoom":
        return setPreference(getDb(), input.key, input.value);
      case "stepLimit":
        return setPreference(getDb(), input.key, input.value);
      default: {
        // 穷尽性守卫：注册新 preference key 后漏补本 switch 的 case 会在此编译报错。
        // （曾静默吞写：readerLayout/summaryModel 缺 case 时 IPC 返回成功但什么都没落盘。）
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
  }),
];

export function registerPreferenceHandlers(): void {
  register(preferencesBindings);

  // 读：同步 sendSync 通道——preload 在首帧前取整份快照（挂 .dark + hydrate）。
  // 故意绕开异步 register；getDb() 在 DB 未就绪时可能抛，整体兜底返回 {}，绝不让首帧读崩。
  ipcMain.on(C.preferencesGetAllSync.channel, (e) => {
    try {
      e.returnValue = getAllPreferences(getDb());
    } catch {
      e.returnValue = {};
    }
  });
}
