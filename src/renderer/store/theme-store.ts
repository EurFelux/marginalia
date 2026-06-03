import { create } from "zustand";
import type { ColorMode } from "@shared/preferences";
import { resolveTheme, type ResolvedTheme } from "@shared/theme";
import { persistPreference } from "@renderer/store/persist-preference";

/** 读系统是否偏好暗色（matchMedia 薄包；headless 无 window → false）。 */
function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

/** 启动初值：preload 已把整份快照同步缓存于 window.api.preferences.getAll()。 */
function initialColorMode(): ColorMode {
  if (typeof window === "undefined") return "system";
  return window.api?.preferences?.getAll?.()?.colorMode ?? "system";
}

interface ThemeState {
  /** 用户选择（持久化）。 */
  colorMode: ColorMode;
  /** 实际生效（派生：system 经 matchMedia 消解）。 */
  resolvedTheme: ResolvedTheme;
  setColorMode: (mode: ColorMode) => void;
  /** OS 外观变化时按当前 colorMode 重解析（仅 system 档有意义）。 */
  syncSystem: () => void;
}

const initMode = initialColorMode();

export const useThemeStore = create<ThemeState>()((set, get) => ({
  colorMode: initMode,
  resolvedTheme: resolveTheme(initMode, prefersDark()),
  setColorMode: (colorMode) => {
    persistPreference({ key: "colorMode", value: colorMode });
    set({ colorMode, resolvedTheme: resolveTheme(colorMode, prefersDark()) });
  },
  syncSystem: () => set({ resolvedTheme: resolveTheme(get().colorMode, prefersDark()) }),
}));
