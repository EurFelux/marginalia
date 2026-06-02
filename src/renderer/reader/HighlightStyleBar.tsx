import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Underline } from "lucide-react";
import type { AnnotationStyle } from "@shared/annotations";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { FILL_COLORS, FILL_SWATCH } from "./highlight";

/** 二级样式工具栏：5 色 + 下划线；create 来自选区，edit 来自点已有高亮（多 笔记/删除）。 */
export function HighlightStyleBar() {
  const styleBar = useReaderStore((s) => s.styleBar);
  const closeStyleBar = useReaderStore((s) => s.closeStyleBar);
  const openNoteModal = useReaderStore((s) => s.openNoteModal);
  const selection = useReaderStore((s) => s.selection);
  const setSelection = useReaderStore((s) => s.setSelection);
  const setLastHighlightStyle = useReaderStore((s) => s.setLastHighlightStyle);
  const bookId = useReaderStore((s) => s.currentBookId);
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement | null>(null);

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") });
  const createM = useMutation({
    mutationFn: window.api.annotations.create,
    onSuccess: invalidate,
  });
  const updateM = useMutation({
    mutationFn: window.api.annotations.update,
    onSuccess: invalidate,
  });
  const deleteM = useMutation({
    mutationFn: window.api.annotations.delete,
    onSuccess: invalidate,
  });

  useEffect(() => {
    if (!styleBar) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // 点栏外即放弃：关栏并清选区，否则主文档点击不会 collapse iframe 选区，
        // 关栏后 store.selection 仍在 → 主工具栏重现。
        closeStyleBar();
        setSelection(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [styleBar, closeStyleBar, setSelection]);

  if (!styleBar || bookId == null) return null;
  const editing = styleBar.target.type === "edit" ? styleBar.target.annotationId : null;
  const current = editing ? annos.data?.find((a) => a.id === editing) : undefined;

  const pickStyle = (style: AnnotationStyle) => {
    setLastHighlightStyle(style); // 记住本次选择，供下次「高亮标记」直接套用
    if (styleBar.target.type === "create") {
      // 同时守 selectedText：CreateAnnotationInput 的 Zod 要求 selectedText/cfiRange 均 min(1)，
      // 否则会穿到 IPC 被拒、而 UI 已清选区，造成静默丢弃。
      if (!selection?.cfiRange || !selection.selectionText) return;
      createM.mutate({
        bookId,
        style,
        note: "",
        selectedText: selection.selectionText,
        cfiRange: selection.cfiRange,
      });
      setSelection(null);
    } else {
      updateM.mutate({ id: styleBar.target.annotationId, patch: { style } });
    }
    closeStyleBar();
  };

  const { rect } = styleBar;
  const left = Math.min(Math.max(rect.x + rect.width / 2, 160), window.innerWidth - 160);
  const top = rect.y - 8;

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 55 }}
      className="flex w-max items-center gap-1.5 rounded-xl border border-border bg-popover p-1.5 shadow-xl"
    >
      {FILL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`高亮 ${c}`}
          onClick={() => pickStyle(c)}
          className={cn(
            "size-5 rounded-full ring-offset-1 ring-offset-popover transition",
            FILL_SWATCH[c],
            current?.style === c ? "ring-2 ring-foreground/60" : "hover:scale-110",
          )}
        />
      ))}
      <button
        type="button"
        aria-label="下划线"
        onClick={() => pickStyle("underline")}
        className={cn(
          "grid size-6 place-items-center rounded-md hover:bg-muted",
          current?.style === "underline" && "bg-muted ring-1 ring-foreground/40",
        )}
      >
        <Underline className="size-4" />
      </button>
      {editing && (
        <>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            aria-label="笔记"
            onClick={() => {
              openNoteModal({ target: { type: "edit", annotationId: editing } });
              closeStyleBar();
            }}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <StickyNoteIcon />
          </button>
          <button
            type="button"
            aria-label="删除"
            onClick={() => {
              deleteM.mutate({ id: editing });
              closeStyleBar();
            }}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}

function StickyNoteIcon() {
  return <span className="text-xs">✎</span>;
}
