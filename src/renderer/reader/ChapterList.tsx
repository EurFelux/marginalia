import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { ScrollArea } from "@renderer/components/ui/scroll-area";

export function ChapterList({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });

  return (
    <ScrollArea className="h-full">
      <nav className="flex flex-col gap-0.5 p-2 font-sans">
        {chapters.isPending && (
          <p className="p-2 text-sm text-muted-foreground">
            {t("reader.toc.loading", "加载目录…")}
          </p>
        )}
        {chapters.isError && (
          <p className="p-2 text-sm text-destructive">
            {t("reader.toc.loadError", "目录读取失败")}
          </p>
        )}
        {chapters.data?.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            {t("reader.toc.empty", "（本书无目录章节）")}
          </p>
        )}
        {chapters.data?.map((ch) => (
          <button
            key={ch.id}
            onClick={() => setCurrentChapter(ch.id)}
            style={{ paddingLeft: `${0.5 + ch.level * 0.875}rem` }}
            className={cn(
              "shrink-0 truncate rounded-md py-1.5 pe-2 text-start transition-colors",
              ch.level === 0 ? "text-sm" : "text-xs",
              ch.id === currentChapterId
                ? "bg-primary/10 font-medium text-primary"
                : ch.level === 0
                  ? "text-foreground/80 hover:bg-muted"
                  : "text-muted-foreground hover:bg-muted",
            )}
          >
            {ch.title ?? t("reader.toc.chapterFallback", "第 {{n}} 章", { n: ch.orderIndex + 1 })}
          </button>
        ))}
      </nav>
    </ScrollArea>
  );
}
