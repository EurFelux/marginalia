import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotebookPen, Pencil, Trash2 } from "lucide-react";
import type { BookSummaryDto } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { CoverImage } from "./CoverImage";
import { BookNotesPanel } from "@renderer/book-notes/BookNotesPanel";

export function BookCover({
  book,
  onOpen,
  onDelete,
  onUpdate,
}: {
  book: BookSummaryDto;
  onOpen: () => void;
  onDelete: () => void;
  onUpdate: (patch: { title: string; author: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const fieldId = useId();

  // 打开时从 book 快照初始化（不预填 id 哈希——哈希是 title=null 的显示回退，不是数据）。
  const openEdit = () => {
    setEditTitle(book.title ?? "");
    setEditAuthor(book.author ?? "");
    setEditOpen(true);
  };

  const saveEdit = () => {
    const title = editTitle.trim();
    if (!title) return;
    onUpdate({ title, author: editAuthor.trim() || null }); // 空作者收敛为 null →「未知作者」
    setEditOpen(false);
  };

  const title = book.title ?? book.id;
  const author = book.author ?? t("library.unknownAuthor", "未知作者");
  const label = `${title} · ${author}`;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              onClick={onOpen}
              aria-label={label}
              title={label}
              className="block w-full overflow-hidden rounded-md shadow-md transition-transform hover:scale-[1.03] hover:shadow-xl"
            />
          }
        >
          <CoverImage book={book} />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={openEdit}>
            <Pencil />
            {t("library.menu.edit", "编辑信息")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setNotesOpen(true)}>
            <NotebookPen />
            {t("library.menu.notes", "查看笔记")}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
            <Trash2 />
            {t("library.menu.delete", "删除")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("library.deleteConfirm.title", "删除《{{title}}》？", { title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "library.deleteConfirm.body",
              "将永久移除这本书及其所有标注、笔记、对话，以及导入的书籍文件。此操作不可撤销。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("library.deleteConfirm.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
            >
              {t("library.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={notesOpen} onOpenChange={setNotesOpen}>
        <DialogContent className="font-sans sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("library.notesDialog.title", "笔记 · {{title}}", { title })}
            </DialogTitle>
          </DialogHeader>
          <div className="h-[60vh]">
            <BookNotesPanel bookId={book.id} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="font-sans sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.editDialog.title", "编辑书籍信息")}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveEdit();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${fieldId}-title`}>
                {t("library.editDialog.bookTitle", "书名")}
              </Label>
              <Input
                id={`${fieldId}-title`}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${fieldId}-author`}>{t("library.editDialog.author", "作者")}</Label>
              <Input
                id={`${fieldId}-author`}
                value={editAuthor}
                onChange={(e) => setEditAuthor(e.target.value)}
                placeholder={t("library.editDialog.authorPlaceholder", "留空则显示「未知作者」")}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
                {t("common.cancel", "取消")}
              </Button>
              <Button type="submit" disabled={editTitle.trim() === ""}>
                {t("common.save", "保存")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
