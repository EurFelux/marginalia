import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

const BADGE: Record<SummaryStatus, { label: string; cls: string }> = {
  pending: { label: "全书摘要待生成", cls: "bg-muted text-muted-foreground" },
  generating: {
    label: "全书摘要生成中",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  ready: { label: "全书摘要就绪", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  unavailable: { label: "全书摘要不可用", cls: "bg-destructive/15 text-destructive" },
};

const PLACEHOLDER: Record<SummaryStatus, string> = {
  pending: "全书摘要尚未生成。点「生成摘要」——把整本书喂给模型，概括核心主题、主要人物与结构脉络。",
  generating: "全书摘要正在生成…（喂入整本书，可能需要些时间）",
  ready: "",
  unavailable: "全书摘要生成失败或暂不可用，可重试。",
};

/**
 * 侧栏顶部书卡：书名/作者 + 全书摘要状态徽标，点开看摘要正文 + 生成按钮。
 * 全书摘要按需生成（不自动），故只在 generating 时轮询；pending 不会自变、不轮询。
 */
export function BookCard({ bookId }: { bookId: string }) {
  const qc = useQueryClient();
  const book = useQuery({
    queryKey: qk.book(bookId),
    queryFn: () => window.api.library.get({ bookId }),
  });
  const summary = useQuery({
    queryKey: qk.bookSummary(bookId),
    queryFn: () => window.api.content.bookSummary({ bookId }),
    refetchInterval: (q) => (q.state.data?.status === "generating" ? 2500 : false),
  });
  const generate = useMutation({
    mutationFn: () => window.api.content.generateBookSummary({ bookId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookSummary(bookId) }),
  });

  const status = summary.data?.status ?? "pending";
  const badge = BADGE[status];
  const canGenerate = status === "pending" || status === "unavailable";

  return (
    <div className="shrink-0 border-b border-border p-3">
      <div className="mb-1.5 min-w-0">
        <div className="truncate font-serif text-sm font-semibold">
          {book.data?.title ?? book.data?.id ?? "（未命名）"}
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
              title="查看全书摘要"
              className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badge.cls)}
            />
          }
        >
          {badge.label}
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-72 text-left">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">全书摘要</span>
            <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", badge.cls)}>
              {badge.label}
            </span>
          </div>
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {status === "ready" ? summary.data?.summary : PLACEHOLDER[status]}
          </p>
          {canGenerate && (
            <Button
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="mt-2"
            >
              {generate.isPending ? "生成中…" : "生成摘要"}
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
