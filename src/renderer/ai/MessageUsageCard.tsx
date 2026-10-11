import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MessageStatus, MessageUsage } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import {
  formatTokens,
  usageCardView,
  type InputSegment,
  type UsageRowKind,
} from "@renderer/ai/usage-card";
import { cn } from "@renderer/lib/utils";

/** 比例条与子行色点：只用前景色的不同深浅，与 app 的单色调一致。 */
const SEGMENT_CLASS: Record<InputSegment, string> = {
  cacheRead: "bg-foreground/75",
  cacheWrite: "bg-foreground/40",
  noCache: "bg-foreground/15",
};

function isSegment(kind: UsageRowKind): kind is InputSegment {
  return kind in SEGMENT_CLASS;
}

/**
 * 助手消息操作栏的用量图标：悬停 / 聚焦弹出本轮 token 用量详情卡
 * （spec 2026-10-11 message-usage-display §3）。
 */
export function MessageUsageCard({
  usage,
  model,
  status,
}: {
  usage: MessageUsage;
  model?: string;
  status?: MessageStatus;
}) {
  const { t, i18n } = useTranslation();
  const view = usageCardView(usage, model, status);
  const rowLabel: Record<UsageRowKind, string> = {
    input: t("ai.usage.input", "输入"),
    cacheRead: t("ai.usage.cacheRead", "缓存命中"),
    cacheWrite: t("ai.usage.cacheWrite", "缓存写入"),
    noCache: t("ai.usage.noCache", "未缓存"),
    output: t("ai.usage.output", "输出"),
    reasoning: t("ai.usage.reasoning", "推理"),
  };

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ai.usage.label", "本轮用量")}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Gauge className="size-3.5" />
      </HoverCardTrigger>
      <HoverCardContent className="flex w-60 flex-col gap-2.5 tabular-nums">
        {(view.model || view.stepCount != null) && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-semibold">{view.model}</span>
            {view.stepCount != null && (
              <span className="shrink-0 text-muted-foreground">
                {t("ai.usage.steps", "{{count}} 步", { count: view.stepCount })}
              </span>
            )}
          </div>
        )}
        {view.segments.length > 0 && (
          <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            {view.segments.map((s) => (
              // 段宽按 token 数分配（运行时计算值，故走内联 style）
              <div key={s.kind} className={SEGMENT_CLASS[s.kind]} style={{ flexGrow: s.tokens }} />
            ))}
          </div>
        )}
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
          {view.rows.map((r) => {
            const main = r.kind === "input" || r.kind === "output";
            return (
              <div
                key={r.kind}
                className={cn("contents", main ? "text-foreground" : "text-muted-foreground")}
              >
                <dt
                  className={cn(
                    "flex items-center gap-1.5",
                    main ? "font-medium" : "ps-3",
                    r.kind === "output" && "mt-1.5",
                  )}
                >
                  {!main && (
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-[2px]",
                        isSegment(r.kind) && SEGMENT_CLASS[r.kind],
                      )}
                    />
                  )}
                  {rowLabel[r.kind]}
                </dt>
                <dd
                  className={cn("text-end", main && "font-medium", r.kind === "output" && "mt-1.5")}
                >
                  {formatTokens(r.tokens, i18n.language)}
                </dd>
              </div>
            );
          })}
        </dl>
        {view.contextTokens != null && (
          <div className="flex justify-between gap-3 border-t border-dashed border-border pt-2 text-muted-foreground">
            <span>{t("ai.usage.context", "上下文")}</span>
            <span>{formatTokens(view.contextTokens, i18n.language)}</span>
          </div>
        )}
        {view.note && (
          <p className="text-muted-foreground">
            {view.note === "aborted"
              ? t("ai.usage.abortedNote", "已中止，未完成的一步不计")
              : t("ai.usage.errorNote", "出错，未完成的一步不计")}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
