import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";
import { chapterSummaryQuery } from "@renderer/query/summary-queries";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useNavigationStore } from "@renderer/store/navigation-store";

/**
 * 阅读器顶栏的本章摘要 pill（spec §3 自 AI 面板迁入）：显示摘要状态，点开弹卡看正文。
 * 摘要在主进程懒生成（pill 按钮手动 / 开章自动触发，pending→generating→ready）；
 * query 配置见 chapterSummaryQuery——派生状态必须绕开全局 staleTime=∞，非终态轮询刷新。
 */
export function SummaryPill() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
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
      "本章摘要尚未生成。点右上「生成摘要」，或在设置里开启「开章自动生成」。就绪后会随提问一并提供给 AI。",
    ),
    generating: t("ai.summary.placeholderGenerating", "本章摘要正在生成…"),
    ready: "",
    unavailable: t("ai.summary.placeholderUnavailable", "本章摘要生成失败或暂不可用，可重试生成。"),
  };

  const summary = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: bookId != null && chapterId != null,
  });

  // 手动点击总是 force：跳过 ready-skip 重新生成（镜像全书摘要按钮语义）；开章自动触发不走这里、不带 force。
  const generate = useMutation({
    mutationFn: () =>
      window.api.content.generateChapterSummary({
        bookId: bookId!,
        chapterId: chapterId!,
        force: true,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId!, chapterId!) }),
    onError: (e) => {
      // 模型未配置（handler 预检 reject）等失败透传真实原因（honest-error），不自动消失。
      toast.error(
        t("ai.summary.generateFailed", "生成摘要失败：{{error}}", { error: (e as Error).message }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  if (!bookId || !chapterId) return null;
  const status = summary.data?.status ?? "pending";
  const badge = BADGE[status];
  const genLabel =
    status === "ready"
      ? t("ai.summary.regenerate", "重新生成")
      : status === "unavailable"
        ? t("ai.summary.retry", "重试")
        : t("ai.summary.generate", "生成摘要");

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
      <PopoverContent align="start" sideOffset={6} className="w-72 text-start">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-xs font-semibold">
            {t("ai.summary.heading", "本章摘要")}
          </span>
          {/* 右上角放生成/重新生成按钮（状态已由触发器 pill 表达，镜像 BookCard）；生成中显示一行提示 */}
          {status === "generating" ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("ai.summary.generating", "生成中…")}
            </span>
          ) : (
            <Button
              size="xs"
              variant={status === "ready" ? "outline" : "default"}
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="shrink-0"
            >
              {generate.isPending ? "…" : genLabel}
            </Button>
          )}
        </div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {status === "ready" ? summary.data?.summary : PLACEHOLDER[status]}
        </p>
      </PopoverContent>
    </Popover>
  );
}
