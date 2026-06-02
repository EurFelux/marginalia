import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft } from "lucide-react";
import { Kbd, KbdGroup, ModKey } from "@renderer/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

/** 居中笔记 modal：create 来自选区（默认 yellow），edit 来自已有标注。 */
export function NoteModal() {
  const noteModal = useReaderStore((s) => s.noteModal);
  const closeNoteModal = useReaderStore((s) => s.closeNoteModal);
  const setSelection = useReaderStore((s) => s.setSelection);
  const lastStyle = useReaderStore((s) => s.lastHighlightStyle);
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
  // modal 内显示被标注/选中的原文引用（create 取打开时的锚点快照，edit 取标注快照）。
  const quote = editing ? current?.selectedText : noteModal?.anchor?.selectedText;

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
      // 用打开时的选区锚点快照（而非易失的 store.selection），缺锚点则不建——防静默丢笔记。
      const anchor = noteModal.anchor;
      if (!anchor) return;
      createM.mutate({
        bookId,
        style: lastStyle,
        note: text,
        selectedText: anchor.selectedText,
        cfiRange: anchor.cfiRange,
      });
      setSelection(null);
    } else {
      updateM.mutate({ id: noteModal.target.annotationId, patch: { note: text } });
    }
    closeNoteModal();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // ESC / 点遮罩 / X 关闭 → 同 dismiss（关 modal + 清选区）
        if (!open) dismiss();
      }}
    >
      <DialogContent className="font-sans sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑笔记" : "添加笔记"}</DialogTitle>
        </DialogHeader>
        {quote && (
          <blockquote className="line-clamp-2 border-l-2 border-border pl-3 font-serif text-sm italic leading-snug text-muted-foreground">
            {quote}
          </blockquote>
        )}
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd(macOS)/Ctrl(Win/Linux)+Enter 保存
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder="写点想法…"
          className="no-scrollbar min-h-40 resize-none leading-relaxed"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>
            取消
          </Button>
          <Button onClick={save}>
            保存
            <KbdGroup>
              <ModKey className="border-transparent bg-primary-foreground/20 text-primary-foreground" />
              <Kbd className="border-transparent bg-primary-foreground/20 text-primary-foreground">
                <CornerDownLeft className="size-3" />
              </Kbd>
            </KbdGroup>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
