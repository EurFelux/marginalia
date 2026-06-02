import { useQuery } from "@tanstack/react-query";
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { usePopover } from "@renderer/lib/use-popover";
import { useReaderStore } from "@renderer/store/reader-store";

const BADGE: Record<SummaryStatus, { label: string; cls: string }> = {
  pending: { label: "摘要待生成", cls: "bg-muted text-muted-foreground" },
  generating: { label: "摘要生成中", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  ready: { label: "摘要就绪", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  unavailable: { label: "摘要不可用", cls: "bg-destructive/15 text-destructive" },
};

const PLACEHOLDER: Record<SummaryStatus, string> = {
  pending: "发送一条消息后会自动生成本章摘要；就绪后会随提问一并提供给 AI。",
  generating: "本章摘要正在生成…",
  ready: "",
  unavailable: "本章摘要暂不可用。",
};

/**
 * AI 面板头部的本章摘要 pill（移植 UP1 SummaryPill）：显示摘要状态，点开弹卡看正文。
 * 摘要由发送消息时在主进程懒生成（pending→generating→ready），故 pending/generating 时轮询刷新。
 */
export function SummaryPill() {
  const bookId = useReaderStore((s) => s.currentBookId);
  const chapterId = useReaderStore((s) => s.currentChapterId);
  const panelOpen = useReaderStore((s) => s.panelOpen);
  const { open, setOpen, ref } = usePopover();

  const summary = useQuery({
    queryKey: qk.chapterSummary(bookId ?? "", chapterId ?? ""),
    queryFn: () => window.api.content.chapterSummary({ bookId: bookId!, chapterId: chapterId! }),
    enabled: panelOpen && bookId != null && chapterId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "pending" || s === "generating" ? 2500 : false;
    },
  });

  if (!bookId || !chapterId) return null;
  const status = summary.data?.status ?? "pending";
  const badge = BADGE[status];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="查看本章摘要"
        className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badge.cls)}
      >
        {badge.label}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-72 rounded-xl border border-border bg-popover p-3 text-left shadow-xl">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">本章摘要</span>
            <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", badge.cls)}>
              {badge.label}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {status === "ready" ? summary.data?.summary : PLACEHOLDER[status]}
          </p>
        </div>
      )}
    </div>
  );
}
