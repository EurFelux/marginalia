import { useState, type ReactNode } from "react";
import type { ChartScale } from "@renderer/stats/chart-scale";
import { cn } from "@renderer/lib/utils";

/** 提示框宽度（px），与 TIP_BOX_CLASS 的 w-44 一致；用于把提示框夹在图内。 */
export const TIP_WIDTH = 176;
/** 统计页图表提示框的外框样式（柱状图与热力图共用）。 */
export const TIP_BOX_CLASS =
  "pointer-events-none absolute z-10 w-44 rounded-lg border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg";

export interface BarChartFrameProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  scale: ChartScale;
  formatTick: (value: number) => string;
  /** 一根柱子；高度用相对绘图区的百分比（顶值为 scale.top）。active = 正被悬停或聚焦。 */
  renderBar: (item: T, active: boolean) => ReactNode;
  /** 提示框内容（外框由本组件提供）。 */
  renderTip: (item: T) => ReactNode;
  ariaLabel: (item: T) => string;
  /** 横轴两端的标签。 */
  xLabel: (item: T) => string;
  /** 绘图区高度类，如 h-40。 */
  plotClassName: string;
  /** 纵轴宽度类，刻度文字越长越宽。 */
  axisClassName?: string;
}

/**
 * 统计页柱状图的共用框架：纵轴刻度、水平网格线、可悬停 / 键盘聚焦的柱位、跟随柱子的提示框、
 * 横轴两端标签（spec 2026-10-12-reading-stats-charts-design §5）。各图只管柱子与提示框内容。
 */
export function BarChartFrame<T>({
  items,
  keyOf,
  scale,
  formatTick,
  renderBar,
  renderTip,
  ariaLabel,
  xLabel,
  plotClassName,
  axisClassName = "w-10",
}: BarChartFrameProps<T>) {
  const [active, setActive] = useState<number | null>(null);
  const { top, ticks } = scale;
  const activeItem = active == null ? undefined : items[active];
  // 刻度与网格线的纵向位置（运行时计算值）
  const at = (v: number) => ({ bottom: `${(v / top) * 100}%` });

  return (
    <div className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5">
      <div
        className={cn(
          "relative text-[11px] tabular-nums text-muted-foreground",
          plotClassName,
          axisClassName,
        )}
        aria-hidden
      >
        {ticks.map((v) => (
          <span
            key={v}
            className="absolute right-0 translate-y-1/2 whitespace-nowrap"
            style={at(v)}
          >
            {formatTick(v)}
          </span>
        ))}
      </div>
      <div className={cn("relative", plotClassName)}>
        {ticks.map((v) => (
          <div key={v} className="absolute inset-x-0 h-px bg-border/70" style={at(v)} />
        ))}
        <div className="absolute inset-0 flex items-end" onMouseLeave={() => setActive(null)}>
          {items.map((item, i) => (
            <div
              key={keyOf(item)}
              tabIndex={0}
              aria-label={ariaLabel(item)}
              className="flex h-full flex-1 items-end justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              {renderBar(item, active === i)}
            </div>
          ))}
        </div>
      </div>
      {activeItem !== undefined && active != null && (
        <div
          className={cn(TIP_BOX_CLASS, "top-0")}
          // 跟随柱子水平居中，并夹在图内（运行时计算值）
          style={{
            left: `clamp(0px, calc(${((active + 0.5) / items.length) * 100}% - ${TIP_WIDTH / 2}px), calc(100% - ${TIP_WIDTH}px))`,
          }}
        >
          {renderTip(activeItem)}
        </div>
      )}
      {items.length > 0 && (
        <div className="col-start-2 mt-1.5 flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{xLabel(items[0])}</span>
          <span>{xLabel(items[items.length - 1])}</span>
        </div>
      )}
    </div>
  );
}
