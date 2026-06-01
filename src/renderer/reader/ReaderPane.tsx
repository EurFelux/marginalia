import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

interface Props {
  bookId: string;
  chapterId: string;
  title: string | null;
}

export function ReaderPane({ bookId, chapterId, title }: Props) {
  const prefs = useReaderStore((s) => s.prefs);
  const chapter = useQuery({
    queryKey: qk.chapter(bookId, chapterId),
    queryFn: () => window.api.content.chapterText({ bookId, chapterId }),
  });

  const paragraphs = (chapter.data?.text ?? "").split("\n").filter((p) => p.trim().length > 0);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <article
        className="mx-auto px-10 py-14 font-serif text-foreground/90"
        style={{
          maxWidth: prefs.maxWidth,
          fontSize: `${1.125 * prefs.fontScale}rem`,
          lineHeight: prefs.lineHeight,
        }}
      >
        {title && (
          <h2 className="mb-8 font-sans text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {title}
          </h2>
        )}
        {chapter.isPending && <p className="text-sm text-muted-foreground">加载正文…</p>}
        {chapter.isError && (
          <p className="text-sm text-destructive">
            章节读取失败：{(chapter.error as Error).message}
          </p>
        )}
        {chapter.data && paragraphs.length === 0 && (
          <p className="text-sm text-muted-foreground">（本章无正文）</p>
        )}
        {paragraphs.map((p, i) => (
          <p key={i} className="mb-6 text-justify">
            {p}
          </p>
        ))}
        {chapter.data?.hasMore && (
          <p className="mt-10 text-center font-sans text-xs text-muted-foreground">
            （本章较长，已显示前 {chapter.data.text.length} 字；章内完整分页见后续里程碑）
          </p>
        )}
      </article>
    </div>
  );
}
