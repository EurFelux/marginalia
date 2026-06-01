import { create } from "zustand";

interface SettingsState {
  open: boolean;
  /** 最近一次连通测试结果显示（null = 未测）。 */
  testResult: { ok: boolean; message?: string } | null;
}

interface SettingsActions {
  setOpen: (open: boolean) => void;
  setTestResult: (result: SettingsState["testResult"]) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  testResult: null,
  setOpen: (open) => set({ open }),
  setTestResult: (testResult) => set({ testResult }),
}));
