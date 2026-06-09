import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useSettingsStore } from "@renderer/store/settings-store";

export function ShellHeader() {
  const { t } = useTranslation();
  const view = useNavigationStore((s) => s.view);
  const showLibrary = useNavigationStore((s) => s.showLibrary);
  const showStats = useNavigationStore((s) => s.showStats);
  const openSettings = useSettingsStore((s) => s.setOpen);

  const pill = (active: boolean) =>
    cn(
      "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border px-6">
      <div className="flex-1">
        <h1 className="font-serif text-xl font-semibold">{t("library.title", "Marginalia")}</h1>
      </div>
      <nav className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted p-1">
        <button type="button" onClick={showLibrary} className={pill(view === "library")}>
          {t("shell.tabLibrary", "书库")}
        </button>
        <button type="button" onClick={showStats} className={pill(view === "stats")}>
          {t("shell.tabStats", "统计")}
        </button>
      </nav>
      <div className="flex flex-1 justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openSettings(true)}
                aria-label={t("settings.title", "设置")}
                className="text-muted-foreground"
              />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent>{t("settings.title", "设置")}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
