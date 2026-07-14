import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { coverGradientClass } from "./cover-palette";

/**
 * 封面图块（从 BookCover 抽出，shelf 卡共用；#48）：有封面走 cover:// 协议，无封面渐变 tile。
 * withText=false 供小尺寸场景（shelf 缩略图）——渐变 tile 上的书名/作者在小宽度下不可读，只留色块。
 */
export function CoverImage({
  book,
  withText = true,
}: {
  book: BookSummaryDto;
  withText?: boolean;
}) {
  const { t } = useTranslation();
  const finishedBadge =
    book.readingState === "finished" ? (
      <span
        aria-label={t("library.finishedBadge", "已读完")}
        title={t("library.finishedBadge", "已读完")}
        className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-md"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    ) : null;

  if (book.hasCover) {
    return (
      <div className="relative">
        <img
          src={`cover://b/${encodeURIComponent(book.id)}`}
          alt=""
          loading="lazy"
          className="aspect-[2/3] w-full object-cover"
        />
        {finishedBadge}
      </div>
    );
  }
  const title = book.title ?? book.id;
  const author = book.author ?? t("library.unknownAuthor", "未知作者");
  return (
    <div className="relative">
      <div
        className={`flex aspect-[2/3] w-full flex-col justify-between bg-gradient-to-br ${coverGradientClass(book.id)} p-3 text-white`}
      >
        {withText && (
          <>
            <span className="line-clamp-4 font-serif text-base font-semibold">{title}</span>
            <span className="truncate text-xs text-white/80">{author}</span>
          </>
        )}
      </div>
      {finishedBadge}
    </div>
  );
}
