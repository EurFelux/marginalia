import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UsageBookRow, UsagePurpose, UsageStatsDto } from "@shared/stats";
import { formatTokens } from "@renderer/lib/format-tokens";
import { cn } from "@renderer/lib/utils";
import { hitRate } from "@renderer/stats/usage/usage-view";

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-semibold">{title}</div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </div>
      {children}
    </div>
  );
}

function EmptyRange() {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {t("stats.usage.emptyRange", "这段时间没有 AI 用量")}
    </p>
  );
}

/** 横向比例条一行：名称（可带副标题）、条、用量、占比。 */
function ShareRow({
  name,
  sub,
  tokens,
  max,
  total,
  muted,
}: {
  name: string;
  sub?: string | null;
  tokens: number;
  max: number;
  total: number;
  muted?: boolean;
}) {
  const { i18n } = useTranslation();
  const pct = new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 });
  const share = tokens / total;
  // 有用量却四舍五入成 0% 会让人以为没用过，写成「<1%」
  const shareText = share > 0 && share < 0.005 ? `<${pct.format(0.01)}` : pct.format(share);
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_4.5rem_3rem] items-center gap-3 text-sm">
      <div className="min-w-0">
        <div className={cn("truncate", muted ? "text-muted-foreground" : "font-medium")}>
          {name}
        </div>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        {/* 条长按本列最大值换算（运行时计算值） */}
        <div
          className="h-full rounded-full bg-foreground/60"
          style={{ width: `${(tokens / max) * 100}%` }}
        />
      </div>
      <span className="text-end font-semibold tabular-nums">
        {formatTokens(tokens, i18n.language)}
      </span>
      <span className="text-end text-muted-foreground tabular-nums">{shareText}</span>
    </li>
  );
}

export function PurposeBreakdown({ data }: { data: UsageStatsDto }) {
  const { t } = useTranslation();
  const names: Record<UsagePurpose, string> = {
    chat: t("stats.usage.purpose.chat", "对话"),
    summary: t("stats.usage.purpose.summary", "摘要"),
    report: t("stats.usage.purpose.report", "阅读报告"),
    compaction: t("stats.usage.purpose.compaction", "上下文压缩"),
    memory: t("stats.usage.purpose.memory", "记忆整理"),
    naming: t("stats.usage.purpose.naming", "会话命名"),
  };
  const total = data.totals.inputTokens + data.totals.outputTokens;
  const max = data.byPurpose[0]?.tokens ?? 0;
  return (
    <Card
      title={t("stats.usage.byPurpose", "按用途")}
      note={t("stats.usage.tokensNote", "输入 + 输出")}
    >
      {data.byPurpose.length === 0 ? (
        <EmptyRange />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {data.byPurpose.map((p) => (
            <ShareRow
              key={p.purpose}
              name={names[p.purpose]}
              tokens={p.tokens}
              max={max}
              total={total}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ModelTable({ data }: { data: UsageStatsDto }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const count = new Intl.NumberFormat(lang);
  const pct = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 });
  const th = "pb-2 ps-3 text-end text-xs font-medium whitespace-nowrap text-muted-foreground";
  const td = "border-t border-border/70 py-2 ps-3 text-end whitespace-nowrap tabular-nums";
  return (
    <Card title={t("stats.usage.byModel", "按模型")}>
      {data.byModel.length === 0 ? (
        <EmptyRange />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={cn(th, "ps-0 text-start")}>{t("stats.usage.model", "模型")}</th>
                <th className={th}>{t("stats.usage.input", "输入")}</th>
                <th className={th}>{t("stats.usage.output", "输出")}</th>
                <th className={th}>{t("stats.usage.hitRate", "缓存命中率")}</th>
                <th className={th}>{t("stats.usage.requests", "调用")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => {
                const rate = hitRate(m);
                return (
                  <tr key={m.model ?? ""}>
                    <td
                      className={cn(
                        td,
                        "ps-0 text-start font-semibold",
                        m.model == null && "font-normal text-muted-foreground",
                      )}
                    >
                      {m.model ?? t("stats.usage.unknownModel", "未知模型")}
                    </td>
                    <td className={td}>{formatTokens(m.inputTokens, lang)}</td>
                    <td className={td}>{formatTokens(m.outputTokens, lang)}</td>
                    <td className={td}>
                      {rate == null ? (
                        "—"
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-1.5 w-11 overflow-hidden rounded-full bg-muted"
                            aria-hidden
                          >
                            <span
                              className="block h-full bg-foreground/60"
                              style={{ width: `${rate * 100}%` }}
                            />
                          </span>
                          {pct.format(rate)}
                        </span>
                      )}
                    </td>
                    <td className={td}>{count.format(m.requests)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function BookBreakdown({ data }: { data: UsageStatsDto }) {
  const { t } = useTranslation();
  const total = data.totals.inputTokens + data.totals.outputTokens;
  const max = data.byBook.reduce((m, b) => Math.max(m, b.tokens), 0);
  const describe = (b: UsageBookRow): { name: string; sub?: string | null; muted?: boolean } => {
    switch (b.kind) {
      case "book":
        return { name: b.title ?? t("library.untitled", "未命名"), sub: b.author };
      case "others":
        return {
          name: t("stats.usage.otherBooks", "其余 {{count}} 本", { count: b.count }),
          muted: true,
        };
      case "none":
        return { name: t("stats.usage.noBook", "不属于某本书"), muted: true };
      case "deleted":
        return {
          name: t("stats.usage.deletedBooks", "已删除的书"),
          sub: t("stats.usage.bookCount", "{{count}} 本", { count: b.count }),
          muted: true,
        };
    }
  };
  return (
    <Card title={t("stats.usage.byBook", "按书")}>
      {data.byBook.length === 0 ? (
        <EmptyRange />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {data.byBook.map((b) => (
            <ShareRow
              key={b.kind === "book" ? b.bookId : b.kind}
              {...describe(b)}
              tokens={b.tokens}
              max={max}
              total={total}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
