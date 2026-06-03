import type { ColorMode } from "@shared/preferences";

/** 主题解析后的实际生效值（已消解 system）。 */
export type ResolvedTheme = "light" | "dark";

/** 把三档 colorMode + 系统是否偏好暗 解析为实际生效的 light/dark。纯函数（无 DOM 依赖）。 */
export function resolveTheme(mode: ColorMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
