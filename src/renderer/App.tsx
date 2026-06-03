import { useEffect } from "react";
import { useReaderStore } from "@renderer/store/reader-store";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { hydratePreferences } from "@renderer/store/hydrate-preferences";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";
import { SettingsPanel } from "@renderer/settings/SettingsPanel";

export function App() {
  const view = useReaderStore((s) => s.view);
  // 启动时从主进程 DB 灌入持久化偏好（字号/行距/栏宽、上次高亮色、自动摘要）。
  useEffect(() => {
    hydratePreferences();
  }, []);
  return (
    <TooltipProvider>
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsPanel />
    </TooltipProvider>
  );
}
