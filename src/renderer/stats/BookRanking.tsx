import { useTranslation } from "react-i18next";
import type { BookReadingTotal } from "@shared/stats";
import { formatDuration } from "@renderer/stats/format-duration";

export function BookRanking({ perBook }: { perBook: BookReadingTotal[] }) {
  const { t } = useTranslation();
  const h = t("stats.unitHour", "h");
  const m = t("stats.unitMin", "m");
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-sm font-semibold">{t("stats.ranking", "各书时长排行")}</div>
      <ul>
        {perBook.map((b, i) => (
          <li
            key={b.bookId}
            className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 border-b border-border/60 py-2 last:border-0"
          >
            <span className="text-center text-sm font-semibold text-muted-foreground">{i + 1}</span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {b.title ?? t("library.untitled", "未命名")}
              </div>
              {b.author && <div className="truncate text-xs text-muted-foreground">{b.author}</div>}
            </div>
            <span className="text-sm font-semibold tabular-nums">
              {formatDuration(b.seconds, h, m)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
