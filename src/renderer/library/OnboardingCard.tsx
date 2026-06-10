import { Check, Lock, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { cn } from "@renderer/lib/utils";
import { isModelConnected, isOnboardingComplete, summaryModelBackfill } from "./onboarding-logic";

/** 首启引导卡片：仅书库显示；连接 AI 模型 + 开启自动摘要两步，配齐或跳过即消失。 */
export function OnboardingCard() {
  const { t } = useTranslation();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });

  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const chatModel = usePrefsStore((s) => s.chatModel);
  const summaryModel = usePrefsStore((s) => s.summaryModel);
  const dismissed = usePrefsStore((s) => s.onboardingDismissed);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  const setSummaryModel = usePrefsStore((s) => s.setSummaryModel);
  const setOnboardingDismissed = usePrefsStore((s) => s.setOnboardingDismissed);

  const openSettings = useSettingsStore((s) => s.setOpen);
  const setCategory = useSettingsStore((s) => s.setActiveCategory);

  const modelConnected = isModelConnected(chatModel, providers.data);
  const complete = isOnboardingComplete(modelConnected, autoSummarize);

  // 已跳过/已完成不显示；query 未就绪先不渲染，避免「未连接→已连接」闪烁。
  if (dismissed) return null;
  if (providers.isPending) return null;
  if (complete) return null;

  const onConfigureModel = () => {
    setCategory("models");
    openSettings(true);
  };

  // 开启自动摘要：命令式一次性完成（非 effect 模拟）。顺手兜底 summaryModel，并持久化 dismissed。
  const onEnableAutoSummary = () => {
    const backfill = summaryModelBackfill(summaryModel, chatModel);
    if (backfill) setSummaryModel(backfill);
    setAutoSummarize(true);
    setOnboardingDismissed(true);
  };

  return (
    <section
      aria-labelledby="onboarding-title"
      className="relative mb-5 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOnboardingDismissed(true)}
        aria-label={t("onboarding.skip", "以后再说")}
        className="absolute end-2 top-2 size-7 text-muted-foreground"
      >
        <X className="size-4" />
      </Button>

      <h2 id="onboarding-title" className="mb-0.5 font-serif text-base text-foreground">
        {t("onboarding.title", "开启 AI 阅读伴侣")}
      </h2>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t(
          "onboarding.subtitle",
          "选中文字向 AI 提问、自动生成章节摘要。读书本身不需要这些——随时可跳过。",
        )}
      </p>

      {/* 步骤①：连接 AI 模型 */}
      <div className="flex items-center gap-3 py-1.5">
        <span
          className={cn(
            "flex size-[18px] flex-none items-center justify-center rounded-full border",
            modelConnected
              ? "border-transparent bg-emerald-600 text-white"
              : "border-muted-foreground/40",
          )}
        >
          {modelConnected && <Check className="size-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-sm",
              modelConnected ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {t("onboarding.step1.title", "连接 AI 模型")}
          </div>
          {!modelConnected && (
            <div className="text-[11px] text-muted-foreground">
              {t("onboarding.step1.hint", "填一个模型服务的密钥并选择对话模型")}
            </div>
          )}
        </div>
        {!modelConnected && (
          <Button variant="outline" size="sm" onClick={onConfigureModel}>
            {t("onboarding.step1.action", "去配置")}
          </Button>
        )}
      </div>

      {/* 步骤②：开启自动章节摘要（步骤①完成前锁定） */}
      <div className="flex items-center gap-3 border-t border-border/60 py-1.5">
        <span
          className={cn(
            "flex size-[18px] flex-none items-center justify-center rounded-full border",
            modelConnected
              ? "border-muted-foreground/40"
              : "border-dashed border-muted-foreground/40 text-muted-foreground/50",
          )}
        >
          {!modelConnected && <Lock className="size-2.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-sm",
              modelConnected ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {t("onboarding.step2.title", "开启自动章节摘要")}
          </div>
          <div
            className={cn(
              "text-[11px]",
              modelConnected ? "text-muted-foreground" : "text-muted-foreground/60",
            )}
          >
            {modelConnected
              ? t("onboarding.step2.hint", "打开时自动用对话模型作摘要模型")
              : t("onboarding.step2.locked", "先完成上一步")}
          </div>
        </div>
        <Checkbox
          checked={autoSummarize}
          disabled={!modelConnected}
          onCheckedChange={(v) => {
            if (v) onEnableAutoSummary();
          }}
          aria-label={t("onboarding.step2.title", "开启自动章节摘要")}
        />
      </div>
    </section>
  );
}
