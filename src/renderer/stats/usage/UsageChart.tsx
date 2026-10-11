import { useTranslation } from "react-i18next";
import type { UsageBucket, UsageStatsDto } from "@shared/stats";
import { formatTokens } from "@renderer/lib/format-tokens";
import { cn } from "@renderer/lib/utils";
import { BarChartFrame } from "@renderer/stats/BarChartFrame";
import { bucketLabel, chartScale } from "@renderer/stats/chart-scale";
import { bucketSegments } from "@renderer/stats/usage/usage-view";

type Segment = "read" | "rest" | "out";
const SEGMENTS: Segment[] = ["read", "rest", "out"];
/** 与用量卡同一套前景色深浅（单色调）。 */
const SEGMENT_CLASS: Record<Segment, string> = {
  read: "bg-foreground/75",
  rest: "bg-foreground/40",
  out: "bg-foreground/15",
};

/** 用量图：每根柱子自下而上叠缓存命中 / 其余输入 / 输出（spec 2026-10-12-ai-usage-stats-design §3.4）。 */
export function UsageChart({ data }: { data: UsageStatsDto }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const series = data.series;
  const scale = chartScale(series.reduce((m, b) => Math.max(m, b.inputTokens + b.outputTokens), 0));
  const label = (b: UsageBucket) => bucketLabel(b.key, data.granularity, lang);
  const segmentName: Record<Segment, string> = {
    read: t("stats.usage.cacheRead", "缓存命中"),
    rest: t("stats.usage.otherInput", "其余输入"),
    out: t("stats.usage.output", "输出"),
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-semibold">
          {data.granularity === "day"
            ? t("stats.usage.dailyTitle", "每日用量")
            : t("stats.usage.monthlyTitle", "每月用量")}
        </div>
        <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
          {SEGMENTS.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[3px]", SEGMENT_CLASS[s])} aria-hidden />
              {segmentName[s]}
            </span>
          ))}
        </div>
      </div>
      <BarChartFrame
        items={series}
        keyOf={(b) => b.key}
        scale={scale}
        formatTick={(v) => formatTokens(v, lang)}
        plotClassName="h-40"
        xLabel={label}
        ariaLabel={(b) => `${label(b)}: ${formatTokens(b.inputTokens + b.outputTokens, lang)}`}
        renderBar={(b, active) => {
          const segs = bucketSegments(b);
          const total = b.inputTokens + b.outputTokens;
          if (total <= 0) return <div className="h-0.5 w-[min(24px,72%)] rounded-full bg-muted" />;
          return (
            <div
              className={cn(
                "flex w-[min(24px,72%)] flex-col-reverse gap-0.5",
                active && "brightness-90",
              )}
              // 柱高按 token 数占顶值的比例（运行时计算值）；各段在柱内按 token 数分高度
              style={{ height: `${(total / scale.top) * 100}%` }}
            >
              {SEGMENTS.filter((s) => segs[s] > 0).map((s) => (
                <div
                  key={s}
                  className={cn(SEGMENT_CLASS[s], "min-h-0.5 basis-0 last:rounded-t-[4px]")}
                  style={{ flexGrow: segs[s] }}
                />
              ))}
            </div>
          );
        }}
        renderTip={(b) => {
          const segs = bucketSegments(b);
          return (
            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              <span className="col-span-2 mb-0.5 font-semibold">{label(b)}</span>
              {SEGMENTS.map((s) => (
                <TipRow
                  key={s}
                  swatch={SEGMENT_CLASS[s]}
                  name={segmentName[s]}
                  value={formatTokens(segs[s], lang)}
                />
              ))}
              <span className="mt-0.5 border-t border-border pt-1 text-muted-foreground">
                {t("stats.usage.tipTotal", "合计 · {{count}} 次调用", { count: b.requests })}
              </span>
              <span className="mt-0.5 border-t border-border pt-1 text-end tabular-nums">
                {formatTokens(b.inputTokens + b.outputTokens, lang)}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

function TipRow({ swatch, name, value }: { swatch: string; name: string; value: string }) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className={cn("size-2 rounded-[2px]", swatch)} aria-hidden />
        {name}
      </span>
      <span className="text-end tabular-nums">{value}</span>
    </>
  );
}
