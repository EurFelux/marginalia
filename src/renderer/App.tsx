import { useReaderStore } from "@renderer/store/reader-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";
import { SettingsPanel } from "@renderer/settings/SettingsPanel";

export function App() {
  const view = useReaderStore((s) => s.view);
  return (
    <>
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsPanel />
    </>
  );
}
