import { useNavigationStore } from "@renderer/store/navigation-store";
import { LibraryView } from "@renderer/library/LibraryView";
import { StatsView } from "@renderer/stats/StatsView";
import { ShellHeader } from "@renderer/shell/ShellHeader";

export function AppShell() {
  const view = useNavigationStore((s) => s.view);
  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <ShellHeader />
      <div className="min-h-0 flex-1">{view === "stats" ? <StatsView /> : <LibraryView />}</div>
    </div>
  );
}
