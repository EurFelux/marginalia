// src/renderer/query/summary-queries.ts
import type { SummaryStatus } from "@shared/library";
import { qk } from "@renderer/query/keys";

interface SummaryView {
  status: SummaryStatus;
  summary: string | null;
}

type IntervalQuery = { state: { data?: SummaryView } };

/**
 * 摘要是主进程后台异步推进的派生状态（pending→generating→ready/unavailable），渲染层收不到
 * 推送，必须打破全局 staleTime=∞——否则缓存的旧快照在 queryKey 重新激活（换章/换书回来）时
 * 被当作永远新鲜的数据直接展示，且 refetchInterval 计时器只在 fetch 后调度，纯缓存命中根本
 * 不会启动轮询 → UI 永久冻结在「摘要待生成」。staleTime:0 使重新激活必重拉真实状态。
 */
const DERIVED_STATUS = { staleTime: 0 } as const;

/** 章节摘要状态 query（SummaryPill 用；ReaderView 自动生成沿用同 key invalidate）。 */
export function chapterSummaryQuery(bookId: string, chapterId: string) {
  return {
    ...DERIVED_STATUS,
    queryKey: qk.chapterSummary(bookId, chapterId),
    queryFn: (): Promise<SummaryView> => window.api.content.chapterSummary({ bookId, chapterId }),
    // 非终态持续轮询：pending 可能被自动生成/发消息推进，generating 等待完成；
    // data=undefined（query error，如切书瞬间组合失效）也轮询，自愈瞬态错误后恢复真实状态。
    refetchInterval: (q: IntervalQuery) => {
      const s = q.state.data?.status;
      return s === "ready" || s === "unavailable" ? false : 2500;
    },
  } as const;
}

/** 全书摘要状态 query（BookCard 用）：按需生成（无自动路径），只在生成中快轮询流式长出 partial。 */
export function bookSummaryQuery(bookId: string) {
  return {
    ...DERIVED_STATUS,
    queryKey: qk.bookSummary(bookId),
    queryFn: (): Promise<SummaryView> => window.api.content.bookSummary({ bookId }),
    refetchInterval: (q: IntervalQuery) => (q.state.data?.status === "generating" ? 400 : false),
  } as const;
}
