import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { ModelPickerSection } from "./ModelPickerSection";

/**
 * 摘要模型区块（章节/全书摘要 + 会话自动命名；spec §6）。
 * 偏好是原子 (provider, model) 对——切 provider 后的中间态（model 未选）不可落盘，
 * 故 draft 持本地，选定 model 才 setSummaryModel 原子落盘。
 */
export function SummaryModelPicker() {
  const { t } = useTranslation();
  const stored = usePrefsStore((s) => s.summaryModel);
  const setSummaryModel = usePrefsStore((s) => s.setSummaryModel);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);

  const providerId = draftProvider ?? stored?.providerId ?? "";
  // 切回已存 provider 时恢复已存 model；切到别家才显空 placeholder
  const model =
    draftProvider != null && draftProvider !== stored?.providerId ? "" : (stored?.model ?? "");
  const effort = stored?.reasoningEffort;

  return (
    <ModelPickerSection
      title={t("settings.summaryModel", "摘要模型")}
      description={t("settings.summaryModel.desc", "用于章节/全书摘要与会话自动命名")}
      providerId={providerId}
      model={model}
      onProviderChange={setDraftProvider}
      onModelChange={(m) => {
        if (!providerId) return;
        // 改模型保留当前档位（档位与 provider 无关，跨家沿用）。
        setSummaryModel({ providerId, model: m, reasoningEffort: effort });
        setDraftProvider(null);
      }}
      reasoningEffort={effort}
      // 未落盘模型 / 正在切 provider（model 未定）时禁用——无处可挂。
      reasoningEffortDisabled={stored == null || draftProvider != null}
      onReasoningEffortChange={(e) => {
        if (!stored) return;
        setSummaryModel({ providerId: stored.providerId, model: stored.model, reasoningEffort: e });
      }}
    />
  );
}
