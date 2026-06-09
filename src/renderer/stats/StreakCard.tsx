import { useTranslation } from "react-i18next";

export function StreakCard({
  currentStreak,
  longestStreak,
  readingDays,
}: {
  currentStreak: number;
  longestStreak: number;
  readingDays: number;
}) {
  const { t } = useTranslation();
  const block = (label: string, value: number) => (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">
        {t("stats.daysValue", "{{count}} 天", { count: value })}
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-7 rounded-xl border border-border bg-card p-4">
      <span className="text-3xl">🔥</span>
      {block(t("stats.currentStreak", "当前连续"), currentStreak)}
      {block(t("stats.longestStreak", "历史最长"), longestStreak)}
      <div className="ms-auto text-right">
        {block(t("stats.readingDays", "累计阅读"), readingDays)}
      </div>
    </div>
  );
}
