import { Monitor, Moon, Sun } from "lucide-react";
import { colorMode as colorModeSchema } from "@shared/preferences";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { useThemeStore } from "@renderer/store/theme-store";

export function AppearanceSettings() {
  const colorMode = useThemeStore((s) => s.colorMode);
  const setColorMode = useThemeStore((s) => s.setColorMode);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">外观</h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">颜色模式</span>
        <ToggleGroup
          value={[colorMode]}
          onValueChange={(g) => {
            // Base UI ToggleGroup 回传 string[]；用 colorMode 枚举收窄到合法档（避免 as 断言，
            // 非法/空值不写——既挡未来的 item value 笔误，又防清空选中态丢档）。
            const parsed = colorModeSchema.safeParse(g[0]);
            if (parsed.success) setColorMode(parsed.data);
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="light" aria-label="浅色">
            <Sun />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="跟随系统">
            <Monitor />
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="深色">
            <Moon />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </section>
  );
}
