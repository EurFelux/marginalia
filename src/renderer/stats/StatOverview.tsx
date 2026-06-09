import { useTranslation } from "react-i18next";
import { formatDuration } from "@renderer/stats/format-duration";

export function StatOverview({
  totalSeconds,
  todaySeconds,
  weekSeconds,
}: {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number;
}) {
  const { t } = useTranslation();
  const h = t("stats.unitHour", "h");
  const m = t("stats.unitMin", "m");
  const cell = (label: string, seconds: number) => (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-3xl font-bold tabular-nums">{formatDuration(seconds, h, m)}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 gap-4">
      {cell(t("stats.total", "总时长"), totalSeconds)}
      {cell(t("stats.today", "今日"), todaySeconds)}
      {cell(t("stats.week", "近 7 天"), weekSeconds)}
    </div>
  );
}
