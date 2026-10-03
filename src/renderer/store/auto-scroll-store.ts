import { create } from "zustand";

export type AutoScrollStatus = "idle" | "running" | "paused";

interface AutoScrollUiState {
  /** 自动滚动运行态（控制条显隐 + 暂停/继续按钮态）。由 auto-scroll-controller 单向写入。 */
  status: AutoScrollStatus;
}

/** 自动滚动运行态发布（非持久化；速度偏好在 prefs-store.autoScrollSpeed）。 */
export const useAutoScrollStore = create<AutoScrollUiState>()(() => ({ status: "idle" }));
