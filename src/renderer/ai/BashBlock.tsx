// bash 调用的终端块与审批操作栏（spec 2026-10-03-bash-skills-permissions-design §5.4、§6.4）。
// 视觉照原型变体 C 改写（proto/approval-ui 分支 VariantC.tsx，参考图在同目录 reference/），勿另行设计。
import { useState } from "react";
import {
  Check,
  ChevronDown,
  CircleSlash,
  LoaderCircle,
  Timer,
  TriangleAlert,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import { ipcErrorMessage } from "@renderer/lib/ipc-error";
import {
  bashView,
  durationParts,
  tailLines,
  type BashBadge,
  type BashView,
} from "@renderer/ai/bash-view";
import type { ToolPart } from "@renderer/ai/segments";
import { respondToPermission, usePermissionStore } from "@renderer/store/permission-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { analyzeCommand, isTokenPrefix, parsePattern } from "@shared/shell-command";
import type { PermissionRequest, PermissionRespondInput } from "@shared/permissions";

const TAIL_LINES = 4;

function Badge({ badge }: { badge: BashBadge }) {
  const { t } = useTranslation();
  const base =
    "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium";
  switch (badge.kind) {
    case "none":
      return null;
    case "pending":
      return (
        <span className={cn(base, "bg-amber-400/20 text-amber-300")}>
          {t("ai.bash.status.pending", "等待批准")}
        </span>
      );
    case "running":
      return (
        <span className={cn(base, "bg-sky-400/15 text-sky-300")}>
          <LoaderCircle className="size-3 animate-spin" />
          {t("ai.bash.status.running", "运行中")}
        </span>
      );
    case "ok":
      return (
        <span className={cn(base, "bg-emerald-400/15 text-emerald-300")}>
          <Check className="size-3" />0
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "bg-red-400/15 text-red-300")}>
          <X className="size-3" />
          {badge.exitCode ?? "—"}
        </span>
      );
    case "denied":
      return (
        <span className={cn(base, "bg-zinc-400/15 text-zinc-300")}>
          <CircleSlash className="size-3" />
          {badge.by === "rule"
            ? t("ai.bash.status.deniedByRule", "被规则拒绝")
            : t("ai.bash.status.denied", "已拒绝")}
        </span>
      );
    case "timedOut":
      return (
        <span className={cn(base, "bg-red-400/15 text-red-300")}>
          <Timer className="size-3" />
          {t("ai.bash.status.timedOut", "超时")}
        </span>
      );
    case "aborted":
      return (
        <span className={cn(base, "bg-zinc-400/15 text-zinc-300")}>
          {t("ai.bash.status.aborted", "已中止")}
        </span>
      );
    case "error":
      return (
        <span className={cn(base, "bg-red-400/15 text-red-300")}>
          <TriangleAlert className="size-3" />
          {t("ai.bash.status.error", "出错")}
        </span>
      );
  }
}

function formatDuration(ms: number, t: TFunction): string {
  const d = durationParts(ms);
  return d.unit === "sec"
    ? t("ai.bash.durationSec", "{{sec}}.{{centi}} 秒", { sec: d.sec, centi: d.centi })
    : t("ai.bash.durationMin", "{{min}} 分 {{sec}} 秒", { min: d.min, sec: d.sec });
}

function autoApprovalLabel(view: BashView, t: TFunction): string | null {
  switch (view.autoApproval) {
    case "rule":
      return t("ai.bash.auto.rule", "自动批准 · 规则");
    case "session":
      return t("ai.bash.auto.session", "自动批准 · 本会话");
    case "always":
      return t("ai.bash.auto.always", "自动批准 · 总是批准");
    case null:
      return null;
  }
}

export function BashBlock({ part, streaming }: { part: ToolPart; streaming: boolean }) {
  const { t } = useTranslation();
  const request = usePermissionStore((s) => s.pending[part.toolCallId]);
  const view = bashView(part, request, streaming);
  const [expanded, setExpanded] = useState(false);
  const tail = tailLines(view.output, TAIL_LINES, expanded);
  const auto = autoApprovalLabel(view, t);
  const meta = [
    view.durationMs !== null ? formatDuration(view.durationMs, t) : null,
    view.truncated ? t("ai.bash.truncated", "输出已截断") : null,
  ].filter((s): s is string => s !== null);

  return (
    <div className="overflow-hidden rounded-lg bg-zinc-950 font-mono text-[11px] leading-relaxed text-zinc-100 ring-1 ring-black/20">
      <div className="flex items-start gap-2 px-2.5 pt-2">
        <span className="shrink-0 text-emerald-400 select-none">$</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{view.command}</span>
        <Badge badge={view.badge} />
      </div>

      {tail.text && (
        <div className="px-2.5 pt-1 text-zinc-400">
          {tail.hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-zinc-500 hover:text-zinc-300"
            >
              {t("ai.bash.moreLines", "… 还有 {{count}} 行，展开", { count: tail.hidden })}
            </button>
          )}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{tail.text}</pre>
        </div>
      )}

      {view.denial && (
        <p className="px-2.5 pt-1 text-zinc-400">
          {view.denial.by === "rule"
            ? t("ai.bash.deniedByRule", "# 命中拒绝规则「{{rule}}」", { rule: view.denial.rule })
            : view.denial.reason
              ? t("ai.bash.deniedWithReason", "# 你拒绝了：{{reason}}", {
                  reason: view.denial.reason,
                })
              : t("ai.bash.deniedNoReason", "# 你拒绝了")}
        </p>
      )}

      {view.errorMessage && (
        <p className="px-2.5 pt-1 whitespace-pre-wrap break-all text-red-300">
          {view.errorMessage}
        </p>
      )}

      <div className="flex items-center gap-2 px-2.5 pt-1 pb-2 font-sans text-[10px] text-zinc-500">
        {meta.length > 0 && <span>{meta.join(" · ")}</span>}
        {auto && <span>{auto}</span>}
      </div>

      {view.request && <ActionBar request={view.request} />}
    </div>
  );
}

function ActionBar({ request }: { request: PermissionRequest }) {
  const { t } = useTranslation();
  const agentName = usePrefsStore((s) => s.soul.name);
  const [mode, setMode] = useState<"idle" | "deny" | "prefix">("idle");
  const [reason, setReason] = useState("");
  const [prefix, setPrefix] = useState(request.suggestedPrefix ?? "");
  const commandTokens = analyzeCommand(request.command).tokens;
  const prefixTokens = parsePattern(prefix);
  const prefixOk =
    commandTokens !== null && prefixTokens !== null && isTokenPrefix(prefixTokens, commandTokens);

  const respond = (input: PermissionRespondInput) => {
    respondToPermission(input).catch((err: unknown) => {
      toast.error(
        t("ai.bash.respondFailed", "没能提交你的选择：{{message}}", {
          message: ipcErrorMessage(err),
        }),
      );
    });
  };
  const deny = () =>
    respond({ requestId: request.requestId, choice: "deny", reason: reason.trim() || undefined });

  if (mode === "deny") {
    return (
      <div className="flex items-center gap-1.5 border-t border-white/10 bg-white/5 px-2 py-1.5 font-sans">
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) deny();
            if (e.key === "Escape") setMode("idle");
          }}
          placeholder={t("ai.bash.denyPlaceholder", "告诉 AI 为什么拒绝（可选），回车确认")}
          className="min-w-0 flex-1 rounded bg-black/40 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-zinc-500"
        />
        <Button size="xs" variant="destructive" onClick={deny}>
          {t("ai.bash.deny", "拒绝")}
        </Button>
      </div>
    );
  }

  return (
    <div className="border-t border-white/10 bg-white/5 px-2 py-1.5 font-sans">
      {mode === "prefix" && (
        <div className="mb-1.5 space-y-1">
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="shrink-0">{t("ai.bash.prefixLabel", "规则前缀")}</span>
            <input
              autoFocus
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && !e.nativeEvent.isComposing && prefixOk && setMode("idle")
              }
              className={cn(
                "min-w-0 flex-1 rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-zinc-100 outline-none ring-1",
                prefixOk ? "ring-zinc-700" : "ring-red-500",
              )}
            />
          </label>
          {!prefixOk && (
            <p className="text-[10px] text-red-300">
              {t("ai.bash.prefixInvalid", "前缀必须是这条命令开头的完整词")}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="me-auto text-[10px] text-zinc-400">
          {t("ai.bash.requesting", "{{name}} 请求运行", { name: agentName })}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="text-zinc-300 hover:bg-white/10 hover:text-zinc-100"
          onClick={() => setMode("deny")}
        >
          {t("ai.bash.denyMenu", "拒绝…")}
        </Button>
        {/* 分体按钮：两半共用一个圆角外形，中间一条细分隔线；下拉半边为与高度等宽的方块。 */}
        <div className="flex h-6 items-stretch overflow-hidden rounded-md bg-zinc-100 text-zinc-900">
          <button
            type="button"
            className="px-2.5 text-xs font-medium outline-none hover:bg-white focus-visible:bg-white"
            onClick={() => respond({ requestId: request.requestId, choice: "once" })}
          >
            {t("ai.bash.allowOnce", "允许一次")}
          </button>
          <span className="my-1 w-px bg-zinc-300" aria-hidden />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex w-6 items-center justify-center outline-none hover:bg-white focus-visible:bg-white aria-expanded:bg-white"
                  aria-label={t("ai.bash.moreApprovals", "更多批准方式")}
                />
              }
            >
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuGroup>
                {request.simple ? (
                  <>
                    <DropdownMenuItem
                      disabled={!prefixOk}
                      onClick={() =>
                        respond({ requestId: request.requestId, choice: "session", prefix })
                      }
                    >
                      <span>
                        <span className="block">{t("ai.bash.allowSession", "本会话都允许")}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {prefix} …
                        </span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!prefixOk}
                      onClick={() =>
                        respond({ requestId: request.requestId, choice: "always", prefix })
                      }
                    >
                      <span>
                        <span className="block">
                          {t("ai.bash.allowAlways", "总是允许（存为规则）")}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {prefix} …
                        </span>
                        {prefixOk && prefixTokens?.length === 1 && (
                          <span className="block text-xs text-amber-600 dark:text-amber-400">
                            {t(
                              "ai.bash.singleWordWarning",
                              "只有一个词：会放行 {{prefix}} 的所有用法",
                              {
                                prefix,
                              },
                            )}
                          </span>
                        )}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setMode("prefix")}>
                      <span>{t("ai.bash.editPrefix", "修改前缀…")}</span>
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled>
                    <span className="text-xs">
                      {t("ai.bash.compoundOnce", "多段组合命令只能单次批准")}
                    </span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
