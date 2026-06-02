import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PrefsState {
  /** 开章时自动生成本章摘要（默认关——控成本；landing/onboarding 时引导用户开启）。 */
  autoSummarize: boolean;
  setAutoSummarize: (v: boolean) => void;
}

/** 跨会话持久化的应用偏好（localStorage）。纯 UI/行为偏好，不入 DB。 */
export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      autoSummarize: false,
      setAutoSummarize: (autoSummarize) => set({ autoSummarize }),
    }),
    { name: "marginalia-prefs" },
  ),
);
