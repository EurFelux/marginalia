import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { BookSummaryDto } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import { CoverImage } from "@renderer/library/CoverImage";
import { qk } from "@renderer/query/keys";

export function ReadingStartView({ book }: { book: BookSummaryDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const start = async () => {
    if (pending) return;
    setPending(true);
    try {
      await window.api.readingSessions.start({ mode: "continue", bookId: book.id });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.book(book.id) }),
        qc.invalidateQueries({ queryKey: qk.library }),
        qc.invalidateQueries({ queryKey: qk.recentlyRead }),
      ]);
    } catch {
      toast.error(t("readingStart.failed", "无法开始这次阅读，请重试。"), {
        closeButton: true,
        duration: Infinity,
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="flex h-screen items-center justify-center bg-background p-8 font-sans">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <div className="w-40 overflow-hidden rounded-md shadow-xl">
          <CoverImage book={book} />
        </div>
        <div>
          <p className="text-sm font-medium text-primary">
            {t("readingStart.title", "开始这次阅读")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">{book.title ?? book.id}</h1>
          <p className="mt-2 text-muted-foreground">
            {book.author ?? t("library.unknownAuthor", "未知作者")}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            {t(
              "readingStart.description",
              "标记开始，让 Marginalia 将这次阅读的时间和痕迹归在一起。",
            )}
          </p>
        </div>
        <Button onClick={() => void start()} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
          {t("readingStart.action", "开始阅读")}
        </Button>
      </div>
    </main>
  );
}
