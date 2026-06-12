import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "@renderer/store/lazy-storage";

/** 拖拽宽度的合法区间（px）。min 保住 tab 栏不挤爆；max 防把正文挤没。 */
export const PANE_WIDTH_LIMITS = { min: 200, max: 480 } as const;
/** 与改造前的静态 w-64（16rem = 256px）一致，老用户首启无观感变化。 */
export const DEFAULT_SIDEBAR_WIDTH = 256;

/** 拖拽宽度收敛到合法区间（纯函数，单测覆盖）；非有限值回落默认宽。 */
export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(PANE_WIDTH_LIMITS.max, Math.max(PANE_WIDTH_LIMITS.min, Math.round(width)));
}

interface PaneSizeState {
  /** 阅读器左侧栏宽度（px）。 */
  sidebarWidth: number;
}
interface PaneSizeActions {
  setSidebarWidth: (width: number) => void;
}

/**
 * 面板尺寸是纯 UI 状态：走 localStorage（zustand persist），不进主进程 preferences 表。
 * 开关类布局态（sidebarOpen 等）仍在 prefs-store——两者真相源有意分开。
 */
export const usePaneSizeStore = create<PaneSizeState & PaneSizeActions>()(
  persist(
    (set) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      setSidebarWidth: (width) => set({ sidebarWidth: clampPaneWidth(width) }),
    }),
    { name: "marginalia-pane-sizes", storage: safeStorage },
  ),
);
