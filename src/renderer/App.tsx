import { useEffect } from "react";
import { useReaderStore } from "@renderer/store/reader-store";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { hydratePreferences } from "@renderer/store/hydrate-preferences";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";
import { SettingsShell } from "@renderer/settings/SettingsShell";
import { ThemeController } from "@renderer/theme/ThemeController";
import { Toaster } from "@renderer/components/ui/sonner";

export function App() {
  const view = useReaderStore((s) => s.view);
  // 启动时从主进程 DB 灌入持久化偏好（字号/行距/栏宽、上次高亮色、自动摘要）。
  useEffect(() => {
    hydratePreferences();
  }, []);
  return (
    <TooltipProvider>
      <ThemeController />
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsShell />
      <Toaster />
    </TooltipProvider>
  );
}
