import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FileX2 } from "lucide-react";
import { toast } from "sonner";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { useNavigationStore } from "@renderer/store/navigation-store";

/** 书文件缺失时替换 reader 内容区：重连（内容一致才写回）/ 删除 / 返回书库。epub 与 pdf 共享。 */
export function BookFileMissingPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const relink = async () => {
    try {
      const r = await window.api.library.relink({ bookId });
      if (r.status === "ok") {
        toast.success(t("reader.missingFile.relinked", "已重新连接文件"));
        void qc.invalidateQueries({ queryKey: qk.bookBytes(bookId) });
      } else if (r.status === "mismatch") {
        toast.error(t("reader.missingFile.mismatch", "这不是同一个文件（内容不一致）"), {
          closeButton: true,
          duration: Infinity,
        });
      }
      // canceled：无动作
    } catch (e) {
      toast.error(
        t("reader.missingFile.relinkFailed", "重新连接失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    }
  };

  const remove = async () => {
    setConfirmOpen(false);
    try {
      await window.api.library.delete({ bookId });
      backToLibrary();
    } catch (e) {
      toast.error(
        t("reader.missingFile.deleteFailed", "删除失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <FileX2 className="size-12 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-sans text-base font-medium text-foreground">
          {t("reader.missingFile.title", "这本书的文件不见了")}
        </p>
        <p className="max-w-sm font-sans text-sm text-muted-foreground">
          {t(
            "reader.missingFile.body",
            "文件可能被移动或删除。重新选择原文件可恢复阅读（含进度与标注），或从书库删除这本书。",
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void relink()}>
          {t("reader.missingFile.relink", "重新选择文件")}
        </Button>
        <Button variant="outline" onClick={backToLibrary}>
          {t("reader.backToLibrary", "书库")}
        </Button>
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          {t("reader.missingFile.delete", "从书库删除")}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("reader.missingFile.deleteConfirm.title", "从书库删除这本书？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "reader.missingFile.deleteConfirm.body",
              "将永久移除这本书及其所有标注、笔记、对话。此操作不可撤销。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("reader.missingFile.deleteConfirm.cancel", "取消")}
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              {t("reader.missingFile.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
