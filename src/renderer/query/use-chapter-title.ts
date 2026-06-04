import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";

/**
 * 由章节 id 查标题：复用 qk.chapters 缓存（与 ReaderView 同 key，React Query 去重，零额外 IPC）。
 * 章节未找到或 title 为 null（epub 无 TOC 的兜底路径）时返回 null，由调用方自行降级显示。
 */
export function useChapterTitle(chapterId: string | null): string | null {
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });
  if (chapterId == null) return null;
  return chapters.data?.find((c) => c.id === chapterId)?.title ?? null;
}
