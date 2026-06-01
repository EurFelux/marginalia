import { useReaderStore } from "@renderer/store/reader-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { ReaderView } from "@renderer/reader/ReaderView";

// 临时占位——Task 9 完成后改回 `import { SettingsPanel } from "@renderer/settings/SettingsPanel";`
const SettingsPanel = () => null;

export function App() {
  const view = useReaderStore((s) => s.view);
  return (
    <>
      {view === "reader" ? <ReaderView /> : <LibraryView />}
      <SettingsPanel />
    </>
  );
}
