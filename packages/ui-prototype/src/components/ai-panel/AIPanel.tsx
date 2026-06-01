import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "#/components/ui/button";
import { MessageList } from "#/components/ai-panel/MessageList";
import { Composer } from "#/components/ai-panel/Composer";
import { usePopover } from "#/components/use-popover";
import { SUMMARY_BADGE, summaryPlaceholderKey } from "#/summary";
import { useReaderAI } from "#/reader-ai-context";
import { cn } from "#/lib/utils";

export function AIPanel() {
  const { t } = useTranslation();
  const {
    book,
    currentChapterId,
    messages,
    newConversation,
    draftChapterIds,
    conversationChapterIds,
  } = useReaderAI();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 作用域：优先看当前草稿选区，其次已发送会话，最后退回当前阅读章
  const scopeIds = (
    draftChapterIds.length
      ? draftChapterIds
      : conversationChapterIds.length
        ? conversationChapterIds
        : [currentChapterId]
  ).filter(Boolean);
  const cross = scopeIds.length > 1;
  const scopeChapters = scopeIds
    .map((id) => book.chapters.find((c) => c.id === id))
    .filter((c): c is (typeof book.chapters)[number] => Boolean(c));
  const chapterTitles = scopeChapters.map((c) => c.title).join(" · ");

  // 新消息/流式增量 → 滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold">
            {cross ? t("panel.independent") : t("panel.assistant")}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {cross
              ? t("panel.crossScope", { chapters: chapterTitles })
              : t("panel.conversationSuffix", { title: scopeChapters[0]?.title ?? "" })}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {cross ? <CombinedSummary ids={scopeIds} /> : <SummaryPill chapterId={scopeIds[0]} />}
          <Button
            variant="ghost"
            size="icon"
            onClick={newConversation}
            aria-label={t("panel.newConversation")}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </header>

      {cross && (
        <div className="shrink-0 border-b border-border bg-primary/5 px-3 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("panel.crossNotice", { chapters: chapterTitles })}
        </div>
      )}

      <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        <MessageList messages={messages} />
      </div>

      <Composer />
    </div>
  );
}

/** 单章会话：点 pill 弹卡看本章摘要正文（未就绪显示占位 + 演示切换）。 */
function SummaryPill({ chapterId }: { chapterId: string }) {
  const { t } = useTranslation();
  const { book, summaryStatusOf, cycleSummaryStatus } = useReaderAI();
  const { open, setOpen, ref } = usePopover();
  const status = summaryStatusOf(chapterId);
  const badge = SUMMARY_BADGE[status];
  const chap = book.chapters.find((c) => c.id === chapterId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("summary.viewChapter")}
        className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badge.cls)}
      >
        {t(badge.key)}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-72 rounded-xl border border-border bg-popover p-3 text-left shadow-xl">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">
              {t("summary.chapterTitle", { title: chap?.title ?? "" })}
            </span>
            <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", badge.cls)}>
              {t(badge.key)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {status === "ready" ? chap?.summary : t(summaryPlaceholderKey(status))}
          </p>
          <button
            type="button"
            onClick={() => cycleSummaryStatus(chapterId)}
            className="mt-2 text-[11px] text-primary hover:underline"
          >
            {t("summary.demoCycle")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 跨章独立会话：点 pill 弹卡列各章摘要（best-effort，只就绪者计入组合）。 */
function CombinedSummary({ ids }: { ids: string[] }) {
  const { t } = useTranslation();
  const { book, summaryStatusOf } = useReaderAI();
  const { open, setOpen, ref } = usePopover();
  const items = ids.map((id) => {
    const c = book.chapters.find((x) => x.id === id);
    return { id, title: c?.title ?? id, summary: c?.summary ?? "", status: summaryStatusOf(id) };
  });
  const ready = items.filter((i) => i.status === "ready").length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("summary.viewCross")}
        className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
      >
        {t("summary.cross", { ready, total: ids.length })}
      </button>
      {open && (
        <div className="no-scrollbar absolute right-0 top-7 z-50 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-left shadow-xl">
          <div className="mb-2 text-xs font-semibold">{t("summary.crossTitle")}</div>
          <div className="space-y-2.5">
            {items.map((i) => (
              <div key={i.id}>
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="text-[11px] font-medium">{i.title}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 text-[10px]",
                      SUMMARY_BADGE[i.status].cls,
                    )}
                  >
                    {t(SUMMARY_BADGE[i.status].key)}
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {i.status === "ready" ? i.summary : t("summary.notReady")}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
