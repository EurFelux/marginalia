import { useEffect } from "react";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { hydratePreferences } from "@renderer/store/hydrate-preferences";
import { AppShell } from "@renderer/shell/AppShell";
import { ReaderView } from "@renderer/reader/ReaderView";
import { SettingsShell } from "@renderer/settings/SettingsShell";
import { ThemeController } from "@renderer/theme/ThemeController";
import { Toaster } from "@renderer/components/ui/sonner";
import { useStartupUpdateCheck } from "@renderer/update/useStartupUpdateCheck";
import { useAppNotifications } from "@renderer/notifications/app-notifications";

export function App() {
  const view = useNavigationStore((s) => s.view);
  // 启动时从主进程 DB 灌入持久化偏好（字号/行距/栏宽、上次高亮色、自动摘要）。
  useEffect(() => {
    hydratePreferences();
  }, []);
  useStartupUpdateCheck();
  useAppNotifications();
  return (
    <TooltipProvider>
      <ThemeController />
      {view === "reader" ? <ReaderView /> : <AppShell />}
      <SettingsShell />
      <Toaster />
    </TooltipProvider>
  );
}
