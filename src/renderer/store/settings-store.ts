import { create } from "zustand";

export type SettingsCategory = "models" | "appearance" | "reading";

interface SettingsState {
  open: boolean;
  activeCategory: SettingsCategory;
  /** 最近一次连通测试结果显示（null = 未测）。 */
  testResult: { ok: boolean; message?: string } | null;
}
interface SettingsActions {
  setOpen: (open: boolean) => void;
  setActiveCategory: (c: SettingsCategory) => void;
  setTestResult: (result: SettingsState["testResult"]) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  activeCategory: "models",
  testResult: null,
  setOpen: (open) => set({ open }),
  setActiveCategory: (activeCategory) => set({ activeCategory }),
  setTestResult: (testResult) => set({ testResult }),
}));
