import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Loader2, TextSelect, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { SummaryStatus } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import { useChatStore } from "@renderer/store/chat-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { bookSummaryQuery, chapterSummaryQuery } from "@renderer/query/summary-queries";
import { qk } from "@renderer/query/keys";
import type { SummaryView } from "@renderer/ai/summary-chips";
import { selectionContextOf, withoutSelectionContext } from "@renderer/ai/selection-context";
import { createLogger } from "@renderer/logger";

const log = createLogger("ai");

/**
 * 统一上下文 pill 基件（spec §4）：实线亮(on)/实线灰(off)/虚线缺失(missing，正交于亮灰)。
 * hover 整个 pill 触发 HoverCard 预览；主体点击与右侧 × 动作分离（避免嵌套交互元素）。
 */
function ContextPill(props: {
  icon: ReactNode;
  label: string;
  on: boolean;
  missing?: boolean;
  onClick?: () => void;
  ariaPressed?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  trailing?: ReactNode;
  hover: ReactNode;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <div
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              props.missing ? "border-dashed" : "border-solid",
              props.on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
            )}
          />
        }
      >
        {props.onClick ? (
          <button
            type="button"
            onClick={props.onClick}
            aria-pressed={props.ariaPressed}
            className="flex items-center gap-1"
          >
            {props.icon}
            {props.label}
            {props.trailing}
          </button>
        ) : (
          <span className="flex items-center gap-1">
            {props.icon}
            {props.label}
            {props.trailing}
          </span>
        )}
        {props.onRemove && (
          <button
            type="button"
            onClick={props.onRemove}
            aria-label={props.removeLabel}
            className="ms-0.5 text-muted-foreground/60 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </HoverCardTrigger>
      <HoverCardContent>{props.hover}</HoverCardContent>
    </HoverCard>
  );
}

/** 摘要 hover 内容：ready 显正文（限高滚动），其余显状态占位（spec §5）。 */
function SummaryHover({ view }: { view: SummaryView | undefined }) {
  const { t } = useTranslation();
  const status = view?.status ?? "pending";
  if (status === "ready" && view?.summary) {
    return (
      <ScrollArea viewportClassName="max-h-40">
        <p className="whitespace-pre-wrap text-muted-foreground">{view.summary}</p>
      </ScrollArea>
    );
  }
  const placeholder =
    status === "generating"
      ? t("ai.chip.hoverGenerating", "生成中…")
      : status === "unavailable"
        ? t("ai.chip.hoverUnavailable", "生成失败，点击重试")
        : t("ai.chip.hoverPending", "尚未生成，点击生成");
  return <p className="text-muted-foreground">{placeholder}</p>;
}

/**
 * Composer 上方统一上下文 pill 行（spec §4）：摘要 toggle ×2 + 可删除的合并选区 pill。
 * 摘要行为与原 SummaryChipToggles 一致：手动 off→on 且未生成（pending/unavailable）触发生成
 * （主进程 inFlight 幂等兜底）；自动预亮不触发。
 */
export function ContextPillBar() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const summaryChips = useChatStore((s) => s.summaryChips);
  const setSummaryChip = useChatStore((s) => s.setSummaryChip);
  const draftChips = useChatStore((s) => s.draftChips);
  const setDraftChips = useChatStore((s) => s.setDraftChips);

  const chapter = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: !!bookId && !!chapterId,
  });
  const book = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: !!bookId });

  if (!bookId) return null;

  const selCtx = selectionContextOf(draftChips);

  // 手动点亮触发的生成失败要透传真实原因（如「未配置摘要模型」）——与 SummaryPill 显式生成同款 toast；
  // 开章自动触发的静默路径在 ReaderView，不经此处。
  const surfaceGenerateError = (e: unknown) => {
    log.warn("summary generation failed", e);
    toast.error(
      t("ai.summary.generateFailed", "生成摘要失败：{{error}}", { error: (e as Error).message }),
    );
  };

  const toggle = (kind: "chapter" | "book", status: SummaryStatus | undefined, on: boolean) => {
    if (!on && (status === "pending" || status === "unavailable")) {
      if (kind === "chapter" && chapterId) {
        void window.api.content
          .generateChapterSummary({ bookId, chapterId })
          .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
          .catch(surfaceGenerateError);
      } else if (kind === "book") {
        void window.api.content
          .generateBookSummary({ bookId })
          .then(() => qc.invalidateQueries({ queryKey: qk.bookSummary(bookId) }))
          .catch(surfaceGenerateError);
      }
    }
    setSummaryChip(kind, !on);
  };

  const summaryPill = (
    kind: "chapter" | "book",
    label: string,
    view: SummaryView | undefined,
    on: boolean,
    Icon: typeof FileText,
  ) => {
    const status = view?.status;
    return (
      <ContextPill
        icon={
          status === "generating" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Icon className="size-3" />
          )
        }
        label={label}
        on={on}
        missing={status === "pending" || status === "unavailable"}
        onClick={() => toggle(kind, status, on)}
        ariaPressed={on}
        hover={<SummaryHover view={view} />}
      />
    );
  };

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {chapterId &&
        summaryPill(
          "chapter",
          t("ai.chip.chapterSummary", "章节摘要"),
          chapter.data,
          summaryChips.chapter,
          FileText,
        )}
      {summaryPill(
        "book",
        t("ai.chip.bookSummary", "全书摘要"),
        book.data,
        summaryChips.book,
        BookOpen,
      )}
      {selCtx && (
        <ContextPill
          icon={<TextSelect className="size-3" />}
          label={t("ai.chip.selectionContext", "选区上下文")}
          on
          trailing={
            <span className="text-[10px] tabular-nums text-muted-foreground">
              ≈{selCtx.tokenTotal} {t("ai.tokUnit", "tok")}
            </span>
          }
          onRemove={() => setDraftChips(withoutSelectionContext(draftChips))}
          removeLabel={t("ai.chip.removeContext", "移除选区上下文")}
          hover={
            <ScrollArea viewportClassName="max-h-52">
              <div className="space-y-2">
                {selCtx.selection && (
                  <div>
                    <div className="mb-0.5 font-medium text-foreground">
                      {t("ai.chip.selection", "选区")} ·{" "}
                      <span className="tabular-nums">≈{selCtx.selection.tokenCount}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {selCtx.selection.content}
                    </p>
                  </div>
                )}
                {selCtx.paragraph && (
                  <div>
                    <div className="mb-0.5 font-medium text-foreground">
                      {t("ai.chip.paragraph", "段落上下文")} ·{" "}
                      <span className="tabular-nums">≈{selCtx.paragraph.tokenCount}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {selCtx.paragraph.content}
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          }
        />
      )}
    </div>
  );
}
