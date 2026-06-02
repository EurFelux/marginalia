import { useReaderStore } from "@renderer/store/reader-store";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";
import { SettingsPanel } from "@renderer/settings/SettingsPanel";

export function App() {
  const view = useReaderStore((s) => s.view);
  return (
    <TooltipProvider>
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsPanel />
    </TooltipProvider>
  );
}
