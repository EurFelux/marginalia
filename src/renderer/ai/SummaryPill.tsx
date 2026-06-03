import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useReaderStore } from "@renderer/store/reader-store";

/**
 * AI 面板头部的本章摘要 pill（移植 UP1 SummaryPill）：显示摘要状态，点开弹卡看正文。
 * 摘要由发送消息时在主进程懒生成（pending→generating→ready），故 pending/generating 时轮询刷新。
 */
export function SummaryPill() {
  const { t } = useTranslation();
  const bookId = useReaderStore((s) => s.currentBookId);
  const chapterId = useReaderStore((s) => s.currentChapterId);
  const panelOpen = useReaderStore((s) => s.panelOpen);
  const qc = useQueryClient();

  const BADGE: Record<SummaryStatus, { label: string; cls: string }> = {
    pending: {
      label: t("ai.summary.statusPending", "摘要待生成"),
      cls: "bg-muted text-muted-foreground",
    },
    generating: {
      label: t("ai.summary.statusGenerating", "摘要生成中"),
      cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    },
    ready: {
      label: t("ai.summary.statusReady", "摘要就绪"),
      cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    },
    unavailable: {
      label: t("ai.summary.statusUnavailable", "摘要不可用"),
      cls: "bg-destructive/15 text-destructive",
    },
  };

  const PLACEHOLDER: Record<SummaryStatus, string> = {
    pending: t(
      "ai.summary.placeholderPending",
      "本章摘要尚未生成。点下方「生成摘要」，或在设置里开启「开章自动生成」。就绪后会随提问一并提供给 AI。",
    ),
    generating: t("ai.summary.placeholderGenerating", "本章摘要正在生成…"),
    ready: "",
    unavailable: t("ai.summary.placeholderUnavailable", "本章摘要生成失败或暂不可用，可重试生成。"),
  };

  const summary = useQuery({
    queryKey: qk.chapterSummary(bookId ?? "", chapterId ?? ""),
    queryFn: () => window.api.content.chapterSummary({ bookId: bookId!, chapterId: chapterId! }),
    enabled: panelOpen && bookId != null && chapterId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "pending" || s === "generating" ? 2500 : false;
    },
  });

  const generate = useMutation({
    mutationFn: () =>
      window.api.content.generateChapterSummary({ bookId: bookId!, chapterId: chapterId! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId!, chapterId!) }),
  });

  if (!bookId || !chapterId) return null;
  const status = summary.data?.status ?? "pending";
  const badge = BADGE[status];
  const canGenerate = status === "pending" || status === "unavailable";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t("ai.summary.viewTitle", "查看本章摘要")}
            className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badge.cls)}
          />
        }
      >
        {badge.label}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 text-left">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-xs font-semibold">
            {t("ai.summary.heading", "本章摘要")}
          </span>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", badge.cls)}>
            {badge.label}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {status === "ready" ? summary.data?.summary : PLACEHOLDER[status]}
        </p>
        {canGenerate && (
          <Button
            size="sm"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="mt-2"
          >
            {generate.isPending
              ? t("ai.summary.generating", "生成中…")
              : t("ai.summary.generate", "生成摘要")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
