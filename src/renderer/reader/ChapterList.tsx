import { useQuery } from "@tanstack/react-query";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

export function ChapterList({ bookId }: { bookId: string }) {
  const currentChapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });

  return (
    <nav className="flex h-full flex-col gap-0.5 overflow-y-auto p-2 font-sans">
      {chapters.isPending && <p className="p-2 text-sm text-muted-foreground">加载目录…</p>}
      {chapters.isError && <p className="p-2 text-sm text-destructive">目录读取失败</p>}
      {chapters.data?.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">（本书无目录章节）</p>
      )}
      {chapters.data?.map((ch) => (
        <button
          key={ch.id}
          onClick={() => setCurrentChapter(ch.id)}
          // level 缩进为运行时计算值（章/节层级），按 CLAUDE.md 允许内联 style 承载。
          style={{ paddingLeft: `${0.5 + ch.level * 0.875}rem` }}
          className={cn(
            "shrink-0 truncate rounded-md py-1.5 pr-2 text-left transition-colors",
            ch.level === 0 ? "text-sm" : "text-xs",
            ch.id === currentChapterId
              ? "bg-primary/10 font-medium text-primary"
              : ch.level === 0
                ? "text-foreground/80 hover:bg-muted"
                : "text-muted-foreground hover:bg-muted",
          )}
        >
          {ch.title ?? `第 ${ch.orderIndex + 1} 章`}
        </button>
      ))}
    </nav>
  );
}
