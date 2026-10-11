import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DailyPoint } from "@shared/stats";
import { cn } from "@renderer/lib/utils";
import { createLogger } from "@renderer/logger";
import { TIP_BOX_CLASS, TIP_WIDTH } from "@renderer/stats/BarChartFrame";
import { shortMonthLabel, weekdayLabel } from "@renderer/stats/chart-scale";
import { formatDuration } from "@renderer/stats/format-duration";
import { heatmapGrid, type HeatCell, type HeatLevel } from "@renderer/stats/heatmap";
import { ReadingTip } from "@renderer/stats/ReadingTip";

const log = createLogger("stats");

/**
 * 列模板：首列放星期名，其后每周一列，共 HEATMAP_WEEKS（53）列；格子随卡片宽度伸缩、最小 8px，
 * 放不下时外层横向滚动。月份行与格子行共用这一模板以便对齐（Tailwind 类须静态，故写死 53）。
 */
const COLUMNS = "grid grid-cols-[28px_repeat(53,minmax(8px,1fr))] gap-[3px]";

const LEVELS: HeatLevel[] = [0, 1, 2, 3, 4];
/** 左侧只标周一、周三、周五（dayOfWeek 1 / 3 / 5），不论一周从哪天开始。 */
const LABELED_WEEKDAYS = new Set([1, 3, 5]);
/** 空格用 muted，四档用 primary 的深浅（与柱状图同一色系）。 */
const LEVEL_CLASS: Record<HeatLevel, string> = {
  0: "bg-muted",
  1: "bg-primary/20",
  2: "bg-primary/45",
  3: "bg-primary/70",
  4: "bg-primary/95",
};

/** 一周首日（1 = 周一 … 7 = 周日），跟随界面语言；运行时取不到时按周一。 */
function firstDayOfWeek(locale: string): number {
  try {
    return new Intl.Locale(locale).getWeekInfo().firstDay;
  } catch (err) {
    log.warn("week info unavailable; starting weeks on Monday", err);
    return 1;
  }
}

/** 近一年阅读热力图（spec 2026-10-12-reading-stats-charts-design §3）。 */
export function ReadingHeatmap({ daily }: { daily: DailyPoint[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ cell: HeatCell; left: number; top: number } | null>(null);

  // 命令式 effect：打开时横向滚到最右（最近）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  // 主进程把 daily 按本地日期零填充到今天，最后一天即今天
  const today = daily.at(-1)?.day;
  if (!today) return null;
  const grid = heatmapGrid(daily, today, firstDayOfWeek(lang));
  const cells = new Map(grid.weeks.flat().flatMap((c) => (c ? [[c.day, c] as const] : [])));
  const duration = formatDuration(
    grid.totalSeconds,
    t("stats.unitHour", "h"),
    t("stats.unitMin", "m"),
  );

  const onMove = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    const cell = target?.dataset.day ? cells.get(target.dataset.day) : undefined;
    const card = cardRef.current;
    if (!target || !cell || !card) {
      setHover(null);
      return;
    }
    const c = card.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    // 提示框在格子上方水平居中，并夹在卡片内
    const left = Math.max(
      8,
      Math.min(r.left - c.left + r.width / 2 - TIP_WIDTH / 2, c.width - TIP_WIDTH - 8),
    );
    setHover({ cell, left, top: r.top - c.top - 6 });
  };

  return (
    <div ref={cardRef} className="relative rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-semibold">{t("stats.heatmap.title", "近一年")}</div>
        <div className="text-xs text-muted-foreground">
          {t("stats.heatmap.summary", "读过 {{count}} 天 · 共 {{duration}}", {
            count: grid.readDays,
            duration,
          })}
        </div>
      </div>
      <div ref={scrollRef} className="overflow-x-auto pb-0.5">
        <div
          role="img"
          aria-label={t("stats.heatmap.aria", "近一年：读过 {{count}} 天，共 {{duration}}", {
            count: grid.readDays,
            duration,
          })}
          className="min-w-fit text-[11px] leading-none text-muted-foreground"
        >
          <div className={cn(COLUMNS, "mb-1.5")} aria-hidden>
            {grid.months.map((m) => (
              <span
                key={m.month}
                // w-0：标签比一格宽，让文字溢出而不撑宽这一列
                className="row-start-1 w-0 whitespace-nowrap"
                // 落在该月第一列上（运行时计算值；+2 跳过星期名那一列）
                style={{ gridColumnStart: m.col + 2 }}
              >
                {shortMonthLabel(m.month, lang)}
              </span>
            ))}
          </div>
          <div
            className={cn(COLUMNS, "grid-flow-col grid-rows-7")}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {grid.weekdayDays.map((d) => (
              // 窄窗口横向滚动时星期名固定在左侧；文字绝对定位，不参与行高（行高由正方形格子决定）
              <span key={d} className="sticky left-0 z-[1] bg-card" aria-hidden>
                {LABELED_WEEKDAYS.has(Temporal.PlainDate.from(d).dayOfWeek) && (
                  <span className="absolute inset-y-0 left-0 flex items-center">
                    {weekdayLabel(d, lang)}
                  </span>
                )}
              </span>
            ))}
            {grid.weeks.flatMap((week, col) =>
              week.map((cell, row) =>
                cell ? (
                  <div
                    key={cell.day}
                    data-day={cell.day}
                    className={cn(
                      "aspect-square rounded-[2px]",
                      LEVEL_CLASS[cell.level],
                      hover?.cell.day === cell.day && "outline outline-[1.5px] outline-foreground",
                    )}
                  />
                ) : (
                  <div key={`after-today-${col}-${row}`} />
                ),
              ),
            )}
          </div>
        </div>
      </div>
      <div
        className="mt-2.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground"
        aria-hidden
      >
        <span className="me-0.5">{t("stats.heatmap.less", "少")}</span>
        {LEVELS.map((l) => (
          <span key={l} className={cn("size-[11px] rounded-[2px]", LEVEL_CLASS[l])} />
        ))}
        <span className="ms-0.5">{t("stats.heatmap.more", "多")}</span>
      </div>
      {hover && (
        <div
          className={cn(TIP_BOX_CLASS, "-translate-y-full")}
          // 跟随格子定位（运行时计算值）
          style={{ left: hover.left, top: hover.top }}
        >
          <ReadingTip day={hover.cell.day} seconds={hover.cell.seconds} />
        </div>
      )}
    </div>
  );
}
