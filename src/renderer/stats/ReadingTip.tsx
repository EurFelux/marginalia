import { useTranslation } from "react-i18next";
import { longDayLabel } from "@renderer/stats/chart-scale";
import { formatDuration } from "@renderer/stats/format-duration";

/** 阅读图表提示框的内容：完整日期（带星期）+ 阅读时长。柱状图与热力图共用。 */
export function ReadingTip({ day, seconds }: { day: string; seconds: number }) {
  const { t, i18n } = useTranslation();
  const duration = formatDuration(seconds, t("stats.unitHour", "h"), t("stats.unitMin", "m"));
  return (
    <>
      <div className="font-semibold">{longDayLabel(day, i18n.language)}</div>
      <div className="mt-0.5 text-muted-foreground">
        {t("stats.readingTime", "阅读时长 {{duration}}", { duration })}
      </div>
    </>
  );
}
