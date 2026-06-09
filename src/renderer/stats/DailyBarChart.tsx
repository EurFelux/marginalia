import { useTranslation } from "react-i18next";
import type { DailyPoint } from "@shared/stats";

export function DailyBarChart({ daily }: { daily: DailyPoint[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...daily.map((d) => d.seconds));
  const first = daily[0]?.day ?? "";
  const last = daily[daily.length - 1]?.day ?? "";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold">{t("stats.dailyTitle", "每日时长")}</div>
      <div
        className="flex h-28 items-end gap-1"
        role="img"
        aria-label={`${t("stats.dailyTitle", "每日时长")}: ${first} – ${last}`}
      >
        {daily.map((d) => (
          <div
            key={d.day}
            title={d.day}
            className={
              d.seconds > 0 ? "flex-1 rounded-t bg-primary/80" : "flex-1 rounded-t bg-muted"
            }
            style={{ height: `${Math.max(2, (d.seconds / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
