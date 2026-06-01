import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HIGHLIGHT, HIGHLIGHT_COLORS } from "#/highlight";
import { useReaderAI } from "#/reader-ai-context";
import { cn } from "#/lib/utils";

/** 点击已有高亮弹出的编辑卡：换色 / 写笔记 / 删除。点击外部关闭。 */
export function HighlightPopover() {
  const { t } = useTranslation();
  const {
    highlightPopover,
    annotations,
    updateAnnotation,
    removeAnnotation,
    closeHighlightPopover,
  } = useReaderAI();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!highlightPopover) return;
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) closeHighlightPopover();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [highlightPopover, closeHighlightPopover]);

  useEffect(() => {
    if (highlightPopover?.autoFocusNote) noteRef.current?.focus();
  }, [highlightPopover]);

  const ann = highlightPopover
    ? annotations.find((a) => a.id === highlightPopover.annotationId)
    : undefined;
  if (!highlightPopover || !ann) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.min(Math.max(highlightPopover.x, 140), vw - 140);
  const top = Math.min(highlightPopover.y + 12, vh - 200);

  return (
    <div
      ref={cardRef}
      style={{ position: "fixed", left, top, transform: "translateX(-50%)", zIndex: 60 }}
      className="w-64 rounded-xl border border-border bg-popover p-2.5 font-sans shadow-xl"
    >
      <div className="mb-2 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t("highlight.colorAria", { color: t(`color.${c}`) })}
              onClick={() => updateAnnotation(ann.id, { color: c })}
              className={cn(
                "size-5 rounded-full ring-offset-1 ring-offset-popover transition",
                HIGHLIGHT[c].swatch,
                ann.color === c ? "ring-2 ring-foreground/60" : "hover:scale-110",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label={t("annotation.delete")}
          onClick={() => {
            removeAnnotation(ann.id);
            closeHighlightPopover();
          }}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <textarea
        ref={noteRef}
        value={ann.note}
        onChange={(e) => updateAnnotation(ann.id, { note: e.target.value })}
        placeholder={t("highlight.addNote")}
        rows={3}
        className="no-scrollbar w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}
