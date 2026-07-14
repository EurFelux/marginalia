import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { createLogger } from "@renderer/logger";
import { qk } from "@renderer/query/keys";

const log = createLogger("reading");

export function CompleteReadingDialog({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const complete = async () => {
    if (pending) return;
    setPending(true);
    try {
      await window.api.readingSessions.complete({ bookId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.book(bookId) }),
        qc.invalidateQueries({ queryKey: qk.library }),
        qc.invalidateQueries({ queryKey: qk.recentlyRead }),
      ]);
      setOpen(false);
    } catch (error) {
      log.warn("complete reading failed", error);
      toast.error(t("reader.completeReading.failed", "无法完成这次阅读，请重试。"), {
        closeButton: true,
        duration: Infinity,
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("reader.completeReading.action", "完成阅读")}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("reader.completeReading.confirmTitle", "完成这次阅读？")}</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={() => void complete()} disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
            {t("reader.completeReading.action", "完成阅读")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
