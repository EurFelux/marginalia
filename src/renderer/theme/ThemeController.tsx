import { useEffect } from "react";
import { useThemeStore } from "@renderer/store/theme-store";

/**
 * 把 resolvedTheme 落到 <html> 的 .dark class（与 preload 首帧应用一致，负责后续状态变更同步）；
 * colorMode==="system" 时订阅 OS 外观变化，实时重解析。返回 null（无 UI）。
 */
export function ThemeController() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const colorMode = useThemeStore((s) => s.colorMode);
  const syncSystem = useThemeStore((s) => s.syncSystem);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  useEffect(() => {
    if (colorMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncSystem();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [colorMode, syncSystem]);

  return null;
}
