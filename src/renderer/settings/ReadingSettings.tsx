import { useTranslation } from "react-i18next";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { usePrefsStore } from "@renderer/store/prefs-store";

export function ReadingSettings() {
  const { t } = useTranslation();
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.reading", "阅读")}</h2>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="auto-summarize" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.reading.autoSummarize", "开章自动生成本章摘要")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.reading.autoSummarizeDesc",
              "打开 / 切换章节时后台生成本章摘要，就绪后随提问一并提供给 AI（会产生模型调用）。关闭时可在 AI 面板的摘要 pill 里手动生成。",
            )}
          </span>
        </label>
        <Checkbox
          id="auto-summarize"
          checked={autoSummarize}
          onCheckedChange={setAutoSummarize}
          className="mt-0.5"
        />
      </div>
    </section>
  );
}
