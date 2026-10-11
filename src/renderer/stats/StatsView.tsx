import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { StatOverview } from "@renderer/stats/StatOverview";
import { DailyBarChart } from "@renderer/stats/DailyBarChart";
import { StreakCard } from "@renderer/stats/StreakCard";
import { BookRanking } from "@renderer/stats/BookRanking";
import { UsageStatsView } from "@renderer/stats/usage/UsageStatsView";

const DAILY_DAYS = 30;

/** 统计页：「阅读 / AI 用量」两个标签，默认阅读、切换不记忆（spec 2026-10-12-ai-usage-stats-design §3.1）。 */
export function StatsView() {
  const { t } = useTranslation();
  return (
    <ScrollArea className="h-full">
      <Tabs defaultValue="reading" className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <TabsList className="self-start">
          <TabsTrigger value="reading">{t("stats.tab.reading", "阅读")}</TabsTrigger>
          <TabsTrigger value="usage">{t("stats.tab.usage", "AI 用量")}</TabsTrigger>
        </TabsList>
        <TabsContent value="reading">
          <ReadingStats />
        </TabsContent>
        <TabsContent value="usage">
          <UsageStatsView />
        </TabsContent>
      </Tabs>
    </ScrollArea>
  );
}

function ReadingStats() {
  const { t } = useTranslation();
  // staleTime:0 + refetchOnMount：查看统计页时不在 reader、不再累计，切到该 tab 取最新即可，无需轮询。
  const stats = useQuery({
    queryKey: qk.stats(DAILY_DAYS),
    queryFn: () => window.api.stats.get({ dailyDays: DAILY_DAYS }),
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (stats.isPending) {
    return <div className="text-sm text-muted-foreground">{t("stats.loading", "加载统计…")}</div>;
  }
  if (stats.isError || !stats.data) {
    return <div className="text-sm text-destructive">{t("stats.loadError", "读取统计失败")}</div>;
  }
  const d = stats.data;
  if (d.totalSeconds === 0) {
    return (
      <div className="mt-20 text-center text-sm text-muted-foreground">
        {t("stats.empty", "开始阅读后，这里会出现你的阅读统计。")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <StatOverview
        totalSeconds={d.totalSeconds}
        todaySeconds={d.todaySeconds}
        weekSeconds={d.weekSeconds}
      />
      <DailyBarChart daily={d.daily} />
      <StreakCard
        currentStreak={d.currentStreak}
        longestStreak={d.longestStreak}
        readingDays={d.readingDays}
      />
      {d.perBook.length > 0 && <BookRanking perBook={d.perBook} />}
    </div>
  );
}
