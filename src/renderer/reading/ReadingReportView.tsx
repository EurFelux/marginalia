import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import { CoverImage } from "@renderer/library/CoverImage";
import { useNavigationStore } from "@renderer/store/navigation-store";

export function ReadingReportView({ book }: { book: BookSummaryDto }) {
  const { t } = useTranslation();
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const openBookReference = useNavigationStore((s) => s.openBookReference);
  return (
    <main className="flex h-screen items-center justify-center bg-background p-8 font-sans">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <div className="w-40 overflow-hidden rounded-md shadow-xl">
          <CoverImage book={book} />
        </div>
        <div>
          <p className="text-sm font-medium text-primary">{t("reading.complete", "阅读完成")}</p>
          <h1 className="mt-2 text-2xl font-semibold">{book.title ?? book.id}</h1>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={backToLibrary}>
            {t("reader.backToLibrary", "书库")}
          </Button>
          <Button onClick={() => openBookReference(book.id)}>
            {t("reading.openReference", "打开正文参考")}
          </Button>
        </div>
      </div>
    </main>
  );
}
