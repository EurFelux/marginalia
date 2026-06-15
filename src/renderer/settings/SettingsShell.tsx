import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore, type SettingsCategory } from "@renderer/store/settings-store";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { ModelsSettings } from "./ModelsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ReadingSettings } from "./ReadingSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { AgentSettings } from "./AgentSettings";
import { MemorySettings } from "./MemorySettings";
import { WebSearchSettings } from "./WebSearchSettings";

export function SettingsShell() {
  const { t } = useTranslation();
  const open = useSettingsStore((s) => s.open);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const active = useSettingsStore((s) => s.activeCategory);
  const setActive = useSettingsStore((s) => s.setActiveCategory);

  const CATEGORIES: { key: SettingsCategory; label: string }[] = [
    { key: "models", label: t("settings.models", "模型") },
    { key: "appearance", label: t("settings.appearance", "外观") },
    { key: "reading", label: t("settings.reading", "阅读") },
    { key: "agent", label: t("settings.agent", "助手") },
    { key: "memory", label: t("settings.memory", "记忆") },
    { key: "webSearch", label: t("settings.webSearch", "联网搜索") },
    { key: "advanced", label: t("settings.advanced", "高级") },
  ];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title", "设置")}
      className="fixed inset-0 z-50 flex bg-background font-sans"
    >
      <ScrollArea className="w-48 shrink-0 border-e border-border">
        <nav className="flex flex-col gap-1 p-3">
          <div className="mb-2 px-2 font-serif text-base font-semibold">
            {t("settings.title", "设置")}
          </div>
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActive(c.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-start text-sm",
                active === c.key ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              {c.label}
            </button>
          ))}
        </nav>
      </ScrollArea>
      <div className="relative min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(false)}
          className="absolute end-4 top-4 z-10"
          aria-label={t("settings.close", "关闭设置")}
        >
          <X />
        </Button>
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-2xl p-6">
            {active === "models" && <ModelsSettings />}
            {active === "appearance" && <AppearanceSettings />}
            {active === "reading" && <ReadingSettings />}
            {active === "agent" && <AgentSettings />}
            {active === "memory" && <MemorySettings />}
            {active === "webSearch" && <WebSearchSettings />}
            {active === "advanced" && <AdvancedSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
