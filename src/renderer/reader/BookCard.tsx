import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Streamdown } from "streamdown";
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

const BADGE_CLS: Record<SummaryStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  generating: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  ready: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  unavailable: "bg-destructive/15 text-destructive",
};

/**
 * 侧栏顶部书卡：书名/作者 + 全书摘要状态徽标，点开看摘要正文 + 生成按钮。
 * 全书摘要按需生成（不自动），故只在 generating 时轮询；pending 不会自变、不轮询。
 */
export function BookCard({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const book = useQuery({
    queryKey: qk.book(bookId),
    queryFn: () => window.api.library.get({ bookId }),
  });
  const summary = useQuery({
    queryKey: qk.bookSummary(bookId),
    queryFn: () => window.api.content.bookSummary({ bookId }),
    // 生成中以 ~400ms 轮询，让累积的 partial 流式长出来（复用 query，无需新事件通道）。
    refetchInterval: (q) => (q.state.data?.status === "generating" ? 400 : false),
  });
  const generate = useMutation({
    mutationFn: () => window.api.content.generateBookSummary({ bookId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookSummary(bookId) }),
  });

  const status = summary.data?.status ?? "pending";
  const badgeCls = BADGE_CLS[status];
  const text = summary.data?.summary ?? null; // ready=全文；generating=累积 partial（流式）

  const BADGE_LABEL: Record<SummaryStatus, string> = {
    pending: t("reader.bookSummary.statusPending", "全书摘要待生成"),
    generating: t("reader.bookSummary.statusGenerating", "全书摘要生成中"),
    ready: t("reader.bookSummary.statusReady", "全书摘要就绪"),
    unavailable: t("reader.bookSummary.statusUnavailable", "全书摘要不可用"),
  };
  const PLACEHOLDER: Record<SummaryStatus, string> = {
    pending: t(
      "reader.bookSummary.placeholderPending",
      "全书摘要尚未生成。点「生成摘要」——把整本书喂给模型，概括核心主题、主要人物与结构脉络。",
    ),
    generating: t(
      "reader.bookSummary.placeholderGenerating",
      "全书摘要正在生成…（喂入整本书，可能需要些时间）",
    ),
    ready: "",
    unavailable: t(
      "reader.bookSummary.placeholderUnavailable",
      "全书摘要生成失败或暂不可用，可重试。",
    ),
  };

  const genLabel =
    status === "ready"
      ? t("reader.bookSummary.regenerate", "重新生成")
      : status === "unavailable"
        ? t("reader.bookSummary.retry", "重试")
        : t("reader.bookSummary.generate", "生成");

  return (
    <div className="shrink-0 border-b border-border p-3">
      <div className="mb-1.5 min-w-0">
        <div className="truncate font-serif text-sm font-semibold">
          {book.data?.title ?? book.data?.id ?? t("reader.bookSummary.untitled", "（未命名）")}
        </div>
        {book.data?.author && (
          <div className="truncate text-xs text-muted-foreground">{book.data.author}</div>
        )}
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              title={t("reader.bookSummary.viewTitle", "查看全书摘要")}
              className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badgeCls)}
            />
          }
        >
          {BADGE_LABEL[status]}
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-96 text-start">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">
              {t("reader.bookSummary.panelTitle", "全书摘要")}
            </span>
            {/* 右上角放生成/重新生成按钮（状态已由触发器 pill 表达）；生成中显示一行提示 */}
            {status === "generating" ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("reader.bookSummary.generatingLabel", "生成中…")}
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
          <ScrollArea viewportClassName="max-h-96">
            <div className="text-sm leading-relaxed text-foreground">
              {text ? (
                // Streamdown 渲染 markdown（同 AI 消息）；生成中即流式渲染累积的 partial
                <Streamdown>{text}</Streamdown>
              ) : (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {PLACEHOLDER[status]}
                </p>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
