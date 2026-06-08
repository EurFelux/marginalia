import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { clampStepLimit } from "@renderer/settings/settings-logic";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const stepLimit = usePrefsStore((s) => s.stepLimit);
  const setStepLimit = usePrefsStore((s) => s.setStepLimit);
  const unlimited = stepLimit === 0;
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.advanced", "高级")}</h2>

      <div className="flex items-start justify-between gap-3">
        <label htmlFor="step-limit" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.advanced.stepLimit", "单次回复最多步数")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.advanced.stepLimitDesc",
              "AI 单次回复中连续调用工具的步数上限，阅读 PDF 逐页时需要调高。勾选「不限制」后仅靠模型自然停止与手动停止收尾——模型若陷入循环会持续消耗额度。",
            )}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-3">
          <Input
            id="step-limit"
            type="number"
            min={1}
            max={99}
            value={unlimited ? "" : stepLimit}
            disabled={unlimited}
            onChange={(e) => setStepLimit(clampStepLimit(e.target.valueAsNumber))}
            className="w-16"
          />
          <label
            htmlFor="step-limit-unlimited"
            className="flex cursor-pointer items-center gap-1.5"
          >
            <Checkbox
              id="step-limit-unlimited"
              checked={unlimited}
              onCheckedChange={(checked) => setStepLimit(checked ? 0 : DEFAULT_STEP_LIMIT)}
            />
            <span className="text-sm">{t("settings.advanced.stepLimitUnlimited", "不限制")}</span>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("settings.logs", "日志")}</span>
        <Button variant="outline" size="sm" onClick={() => void window.api.app.openLogsDir()}>
          <FolderOpen />
          {t("settings.openLogsFolder", "打开日志文件夹")}
        </Button>
      </div>
    </section>
  );
}
