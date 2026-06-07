import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { coverGradientClass } from "./cover-palette";

export function BookCover({
  book,
  onOpen,
  onDelete,
}: {
  book: BookSummaryDto;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
          {book.hasCover ? (
            <img
              src={`cover://b/${encodeURIComponent(book.id)}`}
              alt=""
              loading="lazy"
              className="aspect-[2/3] w-full object-cover"
            />
          ) : (
            <div
              className={`flex aspect-[2/3] w-full flex-col justify-between bg-gradient-to-br ${coverGradientClass(book.id)} p-3 text-white`}
            >
              <span className="line-clamp-4 font-serif text-base font-semibold">{title}</span>
              <span className="truncate text-xs text-white/80">{author}</span>
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
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
    </>
  );
}
