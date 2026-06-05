import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { ModelPickerSection } from "./ModelPickerSection";

export function AssistantModelPicker() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
  });

  const save = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string | null }) =>
      window.api.settings.assistant.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assistantDefault }),
  });

  return (
    <ModelPickerSection
      title={t("settings.assistantModel", "对话模型")}
      providerId={assistant.data?.providerId ?? ""}
      model={assistant.data?.model ?? ""}
      onProviderChange={(id) => save.mutate({ providerId: id, model: null })}
      onModelChange={(m) => save.mutate({ model: m })}
    />
  );
}
