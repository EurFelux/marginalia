import { create } from "zustand";
import { persistPreference } from "@renderer/store/persist-preference";

interface PrefsState {
  /** 开章时自动生成本章摘要（默认关——控成本；landing/onboarding 时引导用户开启）。 */
  autoSummarize: boolean;
  setAutoSummarize: (v: boolean) => void;
}

/**
 * 应用行为偏好。默认值为未 hydrate 前的初值；启动时由 hydratePreferences 从主进程 DB 灌入，
 * 变更经 persistPreference 落盘（取代早先的 localStorage persist——收口到 preferences 表单一源）。
 */
export const usePrefsStore = create<PrefsState>()((set) => ({
  autoSummarize: false,
  setAutoSummarize: (autoSummarize) => {
    persistPreference({ key: "autoSummarize", value: autoSummarize });
    set({ autoSummarize });
  },
}));
