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
  const model = draftProvider != null ? "" : (stored?.model ?? "");

  return (
    <ModelPickerSection
      title={t("settings.summaryModel", "摘要模型")}
      description={t("settings.summaryModel.desc", "用于章节/全书摘要与会话自动命名")}
      providerId={providerId}
      model={model}
      onProviderChange={setDraftProvider}
      onModelChange={(m) => {
        if (!providerId) return;
        setSummaryModel({ providerId, model: m });
        setDraftProvider(null);
      }}
    />
  );
}
