import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "@renderer/store/lazy-storage";

/**
 * 各面板的宽度约束（px）与默认值。default 与改造前的静态类一致（侧栏 w-64=256、
 * AI 面板 w-96=384），老用户首启无观感变化。min 保住内容不挤爆；max 防把正文挤没。
 */
export const PANE_LIMITS = {
  sidebar: { min: 200, max: 480, default: 256 },
  panel: { min: 280, max: 600, default: 384 },
} as const;
export type PaneId = keyof typeof PANE_LIMITS;

/** 拖拽宽度收敛到该面板的合法区间（纯函数，单测覆盖）；非有限值回落默认宽。 */
export function clampPaneWidth(pane: PaneId, width: number): number {
  const { min, max, default: fallback } = PANE_LIMITS[pane];
  if (!Number.isFinite(width)) return fallback;
  return Math.min(max, Math.max(min, Math.round(width)));
}

interface PaneSizeState {
  /** 阅读器左侧栏宽度（px）。 */
  sidebarWidth: number;
  /** 阅读器右侧 AI 面板宽度（px）。 */
  panelWidth: number;
}
interface PaneSizeActions {
  setSidebarWidth: (width: number) => void;
  setPanelWidth: (width: number) => void;
}

/**
 * 面板尺寸是纯 UI 状态：走 localStorage（zustand persist），不进主进程 preferences 表。
 * 开关类布局态（sidebarOpen 等）仍在 prefs-store——两者真相源有意分开。
 */
export const usePaneSizeStore = create<PaneSizeState & PaneSizeActions>()(
  persist(
    (set) => ({
      sidebarWidth: PANE_LIMITS.sidebar.default,
      panelWidth: PANE_LIMITS.panel.default,
      setSidebarWidth: (width) => set({ sidebarWidth: clampPaneWidth("sidebar", width) }),
      setPanelWidth: (width) => set({ panelWidth: clampPaneWidth("panel", width) }),
    }),
    { name: "marginalia-pane-sizes", storage: safeStorage },
  ),
);
