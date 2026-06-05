import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryStatus } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { useChatStore } from "@renderer/store/chat-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { bookSummaryQuery, chapterSummaryQuery } from "@renderer/query/summary-queries";
import { qk } from "@renderer/query/keys";

/**
 * 常驻摘要 toggle chips（spec §6）：off 灰 / on 亮 / 生成中 spinner。
 * 手动点 on 且未生成（pending/unavailable）→ 触发生成（显式意图）；自动预设 on 不触发生成。
 */
export function SummaryChipToggles() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const summaryChips = useChatStore((s) => s.summaryChips);
  const setSummaryChip = useChatStore((s) => s.setSummaryChip);

  const chapter = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: !!bookId && !!chapterId,
  });
  const book = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: !!bookId });

  if (!bookId) return null;

  const toggle = (kind: "chapter" | "book", status: SummaryStatus | undefined, on: boolean) => {
    if (!on && (status === "pending" || status === "unavailable")) {
      // off→on 且未生成/上次失败：触发生成（fire-and-forget；预检失败经 registry 落日志）
      if (kind === "chapter" && chapterId) {
        void window.api.content
          .generateChapterSummary({ bookId, chapterId })
          .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
          .catch(() => undefined);
      } else if (kind === "book") {
        void window.api.content
          .generateBookSummary({ bookId })
          .then(() => qc.invalidateQueries({ queryKey: qk.bookSummary(bookId) }))
          .catch(() => undefined);
      }
    }
    setSummaryChip(kind, !on);
  };

  const pill = (
    kind: "chapter" | "book",
    label: string,
    status: SummaryStatus | undefined,
    on: boolean,
    Icon: typeof FileText,
  ) => (
    <button
      type="button"
      onClick={() => toggle(kind, status, on)}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        on
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      {status === "generating" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Icon className="size-3" />
      )}
      {label}
    </button>
  );

  return (
    <div className="mb-2 flex gap-1.5">
      {chapterId &&
        pill(
          "chapter",
          t("ai.chip.chapterSummary", "章节摘要"),
          chapter.data?.status,
          summaryChips.chapter,
          FileText,
        )}
      {pill(
        "book",
        t("ai.chip.bookSummary", "全书摘要"),
        book.data?.status,
        summaryChips.book,
        BookOpen,
      )}
    </div>
  );
}
