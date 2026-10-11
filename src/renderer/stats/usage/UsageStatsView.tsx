import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { USAGE_RANGES, type UsageRange, type UsageStatsDto } from "@shared/stats";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { formatTokens } from "@renderer/lib/format-tokens";
import { qk } from "@renderer/query/keys";
import { UsageChart } from "@renderer/stats/usage/UsageChart";
import { BookBreakdown, ModelTable, PurposeBreakdown } from "@renderer/stats/usage/UsageBreakdowns";
import { hitRate } from "@renderer/stats/usage/usage-view";

/** 统计页「AI 用量」标签（spec 2026-10-12-ai-usage-stats-design §3）。 */
export function UsageStatsView() {
  const { t } = useTranslation();
  const [range, setRange] = useState<UsageRange>("30d");
  // 与阅读统计同理：切到该标签取最新即可，无需轮询；换范围时保留上一份数据避免闪空
  const usage = useQuery({
    queryKey: qk.statsUsage(range),
    queryFn: () => window.api.stats.usage({ range }),
    staleTime: 0,
    refetchOnMount: "always",
    placeholderData: keepPreviousData,
  });
  const rangeLabel: Record<UsageRange, string> = {
    "7d": t("stats.usage.range.7d", "近 7 天"),
    "30d": t("stats.usage.range.30d", "近 30 天"),
    all: t("stats.usage.range.all", "全部"),
  };

  if (usage.isPending) {
    return <div className="text-sm text-muted-foreground">{t("stats.loading", "加载统计…")}</div>;
  }
  if (usage.isError || !usage.data) {
    return <div className="text-sm text-destructive">{t("stats.loadError", "读取统计失败")}</div>;
  }
  const d = usage.data;
  if (!d.hasAnyUsage) {
    return (
      <div className="mt-16 text-center text-sm text-muted-foreground">
        {t("stats.usage.empty", "和 AI 对话或生成摘要后，这里会出现用量统计。")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[range]}
        onValueChange={(v) => v[0] && setRange(v[0] as UsageRange)}
        aria-label={t("stats.usage.rangeLabel", "时间范围")}
        className="self-start"
      >
        {USAGE_RANGES.map((r) => (
          <ToggleGroupItem key={r} value={r} className="text-xs">
            {rangeLabel[r]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <UsageOverview data={d} />
      <UsageChart data={d} />
      <PurposeBreakdown data={d} />
      <ModelTable data={d} />
      <BookBreakdown data={d} />
    </div>
  );
}

function UsageOverview({ data }: { data: UsageStatsDto }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { totals } = data;
  const rate = hitRate(totals);
  const pct = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 });
  const count = new Intl.NumberFormat(lang);
  const cell = (label: string, value: string, note: string) => (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-3xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 gap-4">
      {cell(
        t("stats.usage.total", "总用量"),
        formatTokens(totals.inputTokens + totals.outputTokens, lang),
        t("stats.usage.totalNote", "输入 {{input}} · 输出 {{output}}", {
          input: formatTokens(totals.inputTokens, lang),
          output: formatTokens(totals.outputTokens, lang),
        }),
      )}
      {cell(
        t("stats.usage.hitRate", "缓存命中率"),
        rate == null ? "—" : pct.format(rate),
        rate == null
          ? t("stats.usage.noCacheData", "没有缓存数据")
          : t("stats.usage.fromCache", "{{tokens}} 来自缓存", {
              tokens: formatTokens(totals.cacheReadTokens, lang),
            }),
      )}
      {cell(
        t("stats.usage.requestsTitle", "AI 调用"),
        count.format(totals.requests),
        data.days == null
          ? t("stats.usage.requestsAllNote", "含回填的历史对话")
          : t("stats.usage.requestsPerDay", "日均 {{count}} 次", {
              count: Math.round(totals.requests / data.days),
            }),
      )}
    </div>
  );
}
