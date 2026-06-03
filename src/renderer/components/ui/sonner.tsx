import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useThemeStore } from "@renderer/store/theme-store";

/**
 * 全局 toast 容器（sonner）。theme 跟随应用 resolvedTheme（非 next-themes——本项目用自家 theme-store）；
 * richColors 给 success/info/warning/error 上语义色。挂一次于 App 根即可，用 `toast()` 触发。
 */
export function Toaster(props: ToasterProps) {
  const theme = useThemeStore((s) => s.resolvedTheme);
  return (
    <Sonner
      theme={theme}
      richColors
      position="bottom-right"
      className="toaster group font-sans"
      {...props}
    />
  );
}
