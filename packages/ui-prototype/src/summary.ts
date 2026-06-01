import type { SummaryStatus } from "#/mock/types";

/** 摘要状态徽标：i18n key + 配色（AI 面板 pill / 弹卡 / 侧栏书卡共用）。 */
export const SUMMARY_BADGE: Record<SummaryStatus, { key: string; cls: string }> = {
  pending: { key: "summary.pending", cls: "bg-muted text-muted-foreground" },
  generating: {
    key: "summary.generating",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  ready: { key: "summary.ready", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  unavailable: { key: "summary.unavailable", cls: "bg-destructive/15 text-destructive" },
};

/** 未就绪态占位文案的 i18n key（ready 返回空串，调用方仅在非 ready 时用）。 */
export function summaryPlaceholderKey(status: SummaryStatus): string {
  switch (status) {
    case "generating":
      return "summary.placeholderGenerating";
    case "unavailable":
      return "summary.placeholderUnavailable";
    case "pending":
      return "summary.placeholderPending";
    default:
      return "";
  }
}
