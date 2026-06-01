import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Settings } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { ChapterList } from "@renderer/reader/ChapterList";
import { ReaderPane } from "@renderer/reader/ReaderPane";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";
import { AIPanel } from "@renderer/ai/AIPanel";

export function ReaderView() {
  const bookId = useReaderStore((s) => s.currentBookId);
  const chapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);
  const backToLibrary = useReaderStore((s) => s.backToLibrary);
  const panelOpen = useReaderStore((s) => s.panelOpen);
  const setPanelOpen = useReaderStore((s) => s.setPanelOpen);
  const openSettings = useSettingsStore((s) => s.setOpen);

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 首章解析：开书时 currentChapterId 为 null，章节列表到位后回填首章。
  useEffect(() => {
    if (chapterId == null && chapters.data && chapters.data.length > 0) {
      setCurrentChapter(chapters.data[0].id);
    }
  }, [chapterId, chapters.data, setCurrentChapter]);

  if (!bookId) return null;

  const currentTitle = chapters.data?.find((c) => c.id === chapterId)?.title ?? null;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <button
          onClick={backToLibrary}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
          书库
        </button>
        <div className="flex items-center gap-1">
          <ReaderPrefs />
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            aria-label="AI 面板"
            className={cn(
              "rounded-md p-2 hover:bg-muted",
              panelOpen ? "text-primary" : "text-muted-foreground",
            )}
          >
            <MessageSquare className="size-4" />
          </button>
          <button
            onClick={() => openSettings(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            aria-label="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-border bg-muted/30">
          <ChapterList bookId={bookId} />
        </aside>
        <main className="min-w-0 flex-1">
          {chapterId ? (
            <ReaderPane bookId={bookId} chapterId={chapterId} title={currentTitle} />
          ) : (
            <p className="p-10 text-sm text-muted-foreground">
              {chapters.isPending ? "加载章节…" : "本书无可读章节。"}
            </p>
          )}
        </main>
        {/* 始终挂载，用 hidden 切换可见——保住 useChat 对话状态在开合间存活。 */}
        <aside className={cn("w-96 shrink-0 border-l border-border", !panelOpen && "hidden")}>
          <AIPanel />
        </aside>
      </div>
    </div>
  );
}
