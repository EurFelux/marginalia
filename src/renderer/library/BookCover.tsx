import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { coverGradientClass } from "./cover-palette";

export function BookCover({ book, onOpen }: { book: BookSummaryDto; onOpen: () => void }) {
  const { t } = useTranslation();
  const title = book.title ?? book.id;
  const author = book.author ?? t("library.unknownAuthor", "未知作者");
  const label = `${title} · ${author}`;
  return (
    <button
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="block w-full overflow-hidden rounded-md shadow-md transition-transform hover:-translate-y-1 hover:shadow-xl"
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
    </button>
  );
}
