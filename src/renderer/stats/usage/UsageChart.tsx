import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageBucket, UsageStatsDto } from "@shared/stats";
import { formatTokens } from "@renderer/lib/format-tokens";
import { cn } from "@renderer/lib/utils";
import { bucketLabel, bucketSegments, chartScale } from "@renderer/stats/usage/usage-view";

/** 绘图区高度（px），与 h-40 一致；柱段高度按它换算。 */
const PLOT_HEIGHT = 160;
/** 悬停提示框宽度（px），与 w-44 一致；用于把提示框夹在图内。 */
const TIP_WIDTH = 176;

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
  const [active, setActive] = useState<number | null>(null);
  const lang = i18n.language;
  const series = data.series;
  const max = series.reduce((m, b) => Math.max(m, b.inputTokens + b.outputTokens), 0);
  const { top, ticks } = chartScale(max);
  const label = (b: UsageBucket) => bucketLabel(b.key, data.granularity, lang);
  const segmentName: Record<Segment, string> = {
    read: t("stats.usage.cacheRead", "缓存命中"),
    rest: t("stats.usage.otherInput", "其余输入"),
    out: t("stats.usage.output", "输出"),
  };
  const activeBucket = active == null ? null : series[active];

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
      <div className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5">
        <div
          className="relative h-40 w-10 text-[11px] tabular-nums text-muted-foreground"
          aria-hidden
        >
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute right-0 translate-y-1/2"
              style={{ bottom: `${(v / top) * 100}%` }}
            >
              {formatTokens(v, lang)}
            </span>
          ))}
        </div>
        <div className="relative h-40">
          {ticks.map((v) => (
            <div
              key={v}
              className="absolute inset-x-0 h-px bg-border/70"
              style={{ bottom: `${(v / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end" onMouseLeave={() => setActive(null)}>
            {series.map((b, i) => {
              const segs = bucketSegments(b);
              const total = b.inputTokens + b.outputTokens;
              return (
                <div
                  key={b.key}
                  tabIndex={0}
                  aria-label={`${label(b)}: ${formatTokens(total, lang)}`}
                  className="flex h-full flex-1 items-end justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  {total > 0 ? (
                    <div
                      className={cn(
                        "flex w-[min(24px,72%)] flex-col-reverse gap-0.5",
                        active === i && "brightness-90",
                      )}
                    >
                      {SEGMENTS.filter((s) => segs[s] > 0).map((s) => (
                        <div
                          key={s}
                          className={cn(SEGMENT_CLASS[s], "last:rounded-t-[4px]")}
                          // 段高按 token 数换算（运行时计算值）；扣掉 2px 段间隙，最矮 2px 保证可见
                          style={{ height: `${Math.max(2, (segs[s] / top) * PLOT_HEIGHT - 2)}px` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="h-0.5 w-[min(24px,72%)] rounded-full bg-muted" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {activeBucket && active != null && (
          <div
            className="pointer-events-none absolute top-0 z-10 grid w-44 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
            // 提示框跟随柱子水平居中，并夹在图内（运行时计算值）
            style={{
              left: `clamp(0px, calc(${((active + 0.5) / series.length) * 100}% - ${TIP_WIDTH / 2}px), calc(100% - ${TIP_WIDTH}px))`,
            }}
          >
            <span className="col-span-2 mb-0.5 font-semibold">{label(activeBucket)}</span>
            {SEGMENTS.map((s) => (
              <TipRow
                key={s}
                swatch={SEGMENT_CLASS[s]}
                name={segmentName[s]}
                value={formatTokens(bucketSegments(activeBucket)[s], lang)}
              />
            ))}
            <span className="mt-0.5 border-t border-border pt-1 text-muted-foreground">
              {t("stats.usage.tipTotal", "合计 · {{count}} 次调用", {
                count: activeBucket.requests,
              })}
            </span>
            <span className="mt-0.5 border-t border-border pt-1 text-end tabular-nums">
              {formatTokens(activeBucket.inputTokens + activeBucket.outputTokens, lang)}
            </span>
          </div>
        )}
        {series.length > 0 && (
          <div className="col-start-2 mt-1.5 flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{label(series[0])}</span>
            <span>{label(series[series.length - 1])}</span>
          </div>
        )}
      </div>
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
