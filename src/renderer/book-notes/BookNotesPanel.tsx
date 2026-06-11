import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { BookNoteDto } from "@shared/book-notes";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { qk } from "@renderer/query/keys";
import { bookNotesQuery } from "@renderer/query/book-note-queries";
import { relativeTime } from "@renderer/lib/relative-time";
import { BookNoteEditorDialog, type BookNoteEditorState } from "./BookNoteEditorDialog";

/** 书籍级独立笔记面板：侧栏「笔记」tab 与书库「查看笔记」Dialog 渲染同一实例形态。 */
export function BookNotesPanel({ bookId }: { bookId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const notes = useQuery(bookNotesQuery(bookId));
  const [editor, setEditor] = useState<BookNoteEditorState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.bookNotes(bookId) });
  const createM = useMutation({
    mutationFn: window.api.bookNotes.create,
    onSuccess: invalidate,
    onError: (e) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("bookNotes.createError", "笔记保存失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });
  const updateM = useMutation({
    mutationFn: window.api.bookNotes.update,
    onSuccess: invalidate,
    onError: (e) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("bookNotes.updateError", "笔记更新失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });
  const deleteM = useMutation({
    mutationFn: window.api.bookNotes.delete,
    onSuccess: invalidate,
    onError: (e) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("bookNotes.deleteError", "笔记删除失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  const save = (content: string) => {
    if (editor?.mode === "edit") updateM.mutate({ id: editor.noteId, patch: { content } });
    else createM.mutate({ bookId, content });
  };

  const now = Date.now();

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-2 pb-0">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setEditor({ mode: "create" })}
        >
          <Plus />
          {t("bookNotes.add", "新建笔记")}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {notes.isPending ? (
          <p className="p-3 text-sm text-muted-foreground">{t("bookNotes.loading", "加载笔记…")}</p>
        ) : notes.isError ? (
          <p className="p-3 text-sm text-destructive">{t("bookNotes.loadError", "笔记加载失败")}</p>
        ) : (notes.data?.length ?? 0) === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {t("bookNotes.empty", "还没有笔记。写下对这本书的第一条想法吧～")}
          </p>
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-1.5 p-2">
              {(notes.data ?? []).map((n) => (
                <NoteItem
                  key={n.id}
                  note={n}
                  time={relativeTime(n.createdAt, now, i18n.language)}
                  onEdit={() =>
                    setEditor({ mode: "edit", noteId: n.id, initialContent: n.content })
                  }
                  onDelete={() => setConfirmDeleteId(n.id)}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <BookNoteEditorDialog state={editor} onSave={save} onClose={() => setEditor(null)} />

      <AlertDialog
        open={confirmDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("bookNotes.deleteConfirm.title", "删除这条笔记？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("bookNotes.deleteConfirm.body", "此操作不可撤销。")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              {t("common.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDeleteId) deleteM.mutate({ id: confirmDeleteId });
                setConfirmDeleteId(null);
              }}
            >
              {t("bookNotes.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NoteItem({
  note,
  time,
  onEdit,
  onDelete,
}: {
  note: BookNoteDto;
  time: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group rounded-lg border border-border bg-background/60 p-2.5">
      <div className="text-xs leading-relaxed">
        <LocalizedStreamdown>{note.content}</LocalizedStreamdown>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/70">{time}</span>
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("bookNotes.edit", "编辑")}
            onClick={onEdit}
            className="text-muted-foreground"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("bookNotes.delete", "删除")}
            onClick={onDelete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  );
}
