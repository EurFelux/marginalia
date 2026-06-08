import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useNoteHoverStore } from "@renderer/store/note-hover-store";
import { HoverCard, HoverCardContent } from "@renderer/components/ui/hover-card";
import { Button } from "@renderer/components/ui/button";

/**
 * 悬停带笔记高亮时的卡片。受控开合由 note-hover-store 驱动；用虚拟锚点（视口坐标 +
 * positionMethod="fixed"）定位到命中的高亮矩形。卡片本身可移入（onMouseEnter/Leave →
 * store 取消/重起关闭窗口），便于读长笔记与点「编辑」。
 */
export function NoteHoverCard() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const annoId = useNoteHoverStore((s) => s.annoId);
  const anchorRect = useNoteHoverStore((s) => s.anchorRect);
  const open = useNoteHoverStore((s) => s.open);
  const enterCard = useNoteHoverStore((s) => s.enterCard);
  const leaveCard = useNoteHoverStore((s) => s.leaveCard);
  const closeNow = useNoteHoverStore((s) => s.closeNow);
  const openNoteModal = useAnnotationStore((s) => s.openNoteModal);

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });
  const anno = annoId ? annos.data?.find((a) => a.id === annoId) : undefined;

  // 虚拟锚点：把视口坐标 rect 包成 floating-ui VirtualElement（getBoundingClientRect 返回视口坐标）。
  const anchor = anchorRect
    ? {
        getBoundingClientRect: () => {
          const r = anchorRect;
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            top: r.y,
            left: r.x,
            right: r.x + r.width,
            bottom: r.y + r.height,
            toJSON() {},
          } as DOMRect;
        },
      }
    : undefined;

  if (!anno || !anchor) return null;

  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (!next) closeNow();
      }}
    >
      <HoverCardContent
        anchor={anchor}
        positionMethod="fixed"
        side="top"
        align="start"
        onMouseEnter={enterCard}
        onMouseLeave={leaveCard}
      >
        {anno.note && (
          <div className="no-scrollbar max-h-40 overflow-y-auto whitespace-pre-wrap text-popover-foreground">
            {anno.note}
          </div>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground"
            onClick={() => {
              const id = annoId;
              closeNow();
              if (id) openNoteModal({ target: { type: "edit", annotationId: id } });
            }}
          >
            <Pencil className="size-3.5" />
            {t("reader.note.edit", "编辑")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
