import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { qk } from "@renderer/query/keys";

export function CompleteReadingDialog({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const complete = async () => {
    await window.api.readingSessions.complete({ bookId });
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.book(bookId) }),
      qc.invalidateQueries({ queryKey: qk.library }),
      qc.invalidateQueries({ queryKey: qk.recentlyRead }),
    ]);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("reading.complete", "完成阅读")}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("reading.completeConfirm", "完成这次阅读？")}</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={() => void complete()}>{t("reading.complete", "完成阅读")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
