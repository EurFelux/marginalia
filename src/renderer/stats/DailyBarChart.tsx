import { useTranslation } from "react-i18next";
import type { DailyPoint } from "@shared/stats";
import { cn } from "@renderer/lib/utils";
import { BarChartFrame } from "@renderer/stats/BarChartFrame";
import { bucketLabel, durationScale } from "@renderer/stats/chart-scale";
import { formatDuration } from "@renderer/stats/format-duration";
import { ReadingTip } from "@renderer/stats/ReadingTip";

/** 每日时长柱状图：纵轴刻度 + 悬停 / 聚焦看数值（spec 2026-10-12-reading-stats-charts-design §2）。 */
export function DailyBarChart({ daily }: { daily: DailyPoint[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const duration = (s: number) =>
    formatDuration(s, t("stats.unitHour", "h"), t("stats.unitMin", "m"));
  const scale = durationScale(daily.reduce((m, d) => Math.max(m, d.seconds), 0));
  const label = (d: DailyPoint) => bucketLabel(d.day, "day", lang);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold">{t("stats.dailyTitle", "每日时长")}</div>
      <BarChartFrame
        items={daily}
        keyOf={(d) => d.day}
        scale={scale}
        formatTick={(v) => (v === 0 ? "0" : duration(v))}
        plotClassName="h-28"
        axisClassName="w-12"
        xLabel={label}
        ariaLabel={(d) => `${label(d)}: ${duration(d.seconds)}`}
        renderBar={(d, active) =>
          d.seconds > 0 ? (
            <div
              className={cn(
                "w-[min(24px,80%)] rounded-t-[4px]",
                active ? "bg-primary" : "bg-primary/80",
              )}
              // 柱高按时长占顶值的比例（运行时计算值），最矮 2px 保证可见
              style={{ height: `max(2px, ${(d.seconds / scale.top) * 100}%)` }}
            />
          ) : (
            <div className="h-0.5 w-[min(24px,80%)] rounded-full bg-muted" />
          )
        }
        renderTip={(d) => <ReadingTip day={d.day} seconds={d.seconds} />}
      />
    </div>
  );
}
