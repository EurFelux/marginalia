import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { EpubCFI } from "epubjs";
import { Trash2 } from "lucide-react";
import type { AnnotationDto } from "@shared/annotations";
import type { ChapterRefDto } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { STYLE_STRIPE } from "./highlight";

const cfiCompare = new EpubCFI();
function spineOf(cfi: string): number {
  try {
    return new EpubCFI(cfi).spinePos ?? -1;
  } catch {
    return -1;
  }
}

export function AnnotationsList({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const requestScroll = useAnnotationStore((s) => s.requestScroll);
  const qc = useQueryClient();
  const annos = useQuery({
    queryKey: qk.annotations(bookId),
    queryFn: () => window.api.annotations.listByBook({ bookId }),
  });
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });
  const deleteM = useMutation({
    mutationFn: window.api.annotations.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.annotations(bookId) }),
  });

  if (annos.isPending)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {t("reader.annotation.loading", "加载标注…")}
      </p>
    );
  if (annos.isError)
    return (
      <p className="p-3 text-sm text-destructive">
        {t("reader.annotation.loadError", "标注加载失败")}
      </p>
    );
  const list = annos.data ?? [];
  if (list.length === 0)
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("reader.annotation.empty", "还没有标注。划词试试～")}
      </p>
    );

  // 阅读序排序（compare 不可用时回退 spinePos）。
  const sorted = [...list].sort((a, b) => {
    try {
      return cfiCompare.compare(a.locatorRange, b.locatorRange);
    } catch {
      return spineOf(a.locatorRange) - spineOf(b.locatorRange);
    }
  });
  const chapterTitle = (cfi: string): string | null => {
    const sp = spineOf(cfi);
    const ch = (chapters.data ?? []).find((c: ChapterRefDto) => c.orderIndex === sp);
    return ch?.title ?? null;
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1.5 p-2">
        {sorted.map((a) => (
          <AnnoItem
            key={a.id}
            a={a}
            chapter={chapterTitle(a.locatorRange)}
            onGoto={() => requestScroll(a.locatorRange)}
            onDelete={() => deleteM.mutate({ id: a.id })}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function AnnoItem({
  a,
  chapter,
  onGoto,
  onDelete,
}: {
  a: AnnotationDto;
  chapter: string | null;
  onGoto: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex gap-2 rounded-lg border border-border bg-background/60 p-2">
      <span className={cn("w-1 shrink-0 self-stretch rounded-full", STYLE_STRIPE[a.style])} />
      <button type="button" onClick={onGoto} className="min-w-0 flex-1 text-start">
        <div className="line-clamp-2 text-xs leading-relaxed text-foreground">{a.selectedText}</div>
        {a.note && (
          <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">✎ {a.note}</div>
        )}
        {chapter && <div className="mt-1 text-[10px] text-muted-foreground/70">{chapter}</div>}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("reader.annotation.delete", "删除")}
        onClick={onDelete}
        className="shrink-0 self-start text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
