import { create } from "zustand";

export type SettingsCategory =
  | "models"
  | "appearance"
  | "reading"
  | "agent"
  | "memory"
  | "advanced";

interface SettingsState {
  open: boolean;
  activeCategory: SettingsCategory;
}
interface SettingsActions {
  setOpen: (open: boolean) => void;
  setActiveCategory: (c: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  open: false,
  activeCategory: "models",
  setOpen: (open) => set({ open }),
  setActiveCategory: (activeCategory) => set({ activeCategory }),
}));
