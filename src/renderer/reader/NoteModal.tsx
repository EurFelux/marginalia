import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

/** 居中笔记 modal：create 来自选区（默认 yellow），edit 来自已有标注。 */
export function NoteModal() {
  const noteModal = useReaderStore((s) => s.noteModal);
  const closeNoteModal = useReaderStore((s) => s.closeNoteModal);
  const selection = useReaderStore((s) => s.selection);
  const setSelection = useReaderStore((s) => s.setSelection);
  const bookId = useReaderStore((s) => s.currentBookId);
  const qc = useQueryClient();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });

  const editing = noteModal?.target.type === "edit" ? noteModal.target.annotationId : null;
  const current = editing ? annos.data?.find((a) => a.id === editing) : undefined;

  // 打开时初始化文本（edit 取现笔记，create 空）+ 聚焦。
  // 仅依赖 [noteModal, editing]：openNoteModal 每次都 set 全新对象，故每次打开 noteModal 引用必变、
  // effect 必重跑、文本必重置——不必把 current/text 列入依赖（列了反会因 current 变化覆盖用户输入）。
  useEffect(() => {
    if (!noteModal) return;
    setText(editing ? (current?.note ?? "") : "");
    taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteModal, editing]);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") });
  const createM = useMutation({ mutationFn: window.api.annotations.create, onSuccess: invalidate });
  const updateM = useMutation({ mutationFn: window.api.annotations.update, onSuccess: invalidate });

  if (!noteModal || bookId == null) return null;

  // 改①：放弃（取消 / 点遮罩）时一并清选区，否则关 modal 后主工具栏会因 store.selection 仍在而重现。
  const dismiss = () => {
    closeNoteModal();
    setSelection(null);
  };

  const save = () => {
    if (noteModal.target.type === "create") {
      // 改②：连同 selectedText 一起守（CreateAnnotationInput 的 Zod 要求二者均 min(1)）。
      if (!selection?.cfiRange || !selection.selectionText) return;
      createM.mutate({
        bookId,
        style: "yellow",
        note: text,
        selectedText: selection.selectionText,
        cfiRange: selection.cfiRange,
      });
      setSelection(null);
    } else {
      updateM.mutate({ id: noteModal.target.annotationId, patch: { note: text } });
    }
    closeNoteModal();
  };

  return (
    <div
      onMouseDown={dismiss}
      style={{ position: "fixed", inset: 0, zIndex: 70 }}
      className="grid place-items-center bg-black/30"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[36rem] max-w-[90vw] rounded-xl border border-border bg-popover p-5 font-sans shadow-2xl"
      >
        <h2 className="mb-2.5 text-sm font-medium">{editing ? "编辑笔记" : "添加笔记"}</h2>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="写点想法…"
          rows={8}
          className="no-scrollbar w-full resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
