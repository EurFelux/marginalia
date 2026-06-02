import type { SetPreferenceInput } from "@shared/preferences";

/**
 * 把单个偏好异步落盘到主进程 DB（fire-and-forget；失败静默——持久化失败不应打断 UI）。
 * 无 preload（headless 测试 / `window` 未定义）时跳过。本模块不 import 任何 store，避免循环依赖。
 */
export function persistPreference(input: SetPreferenceInput): void {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  void window.api.preferences.set(input).catch(() => {});
}
