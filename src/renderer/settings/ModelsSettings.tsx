import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProviderDto } from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { AssistantModelPicker } from "./AssistantModelPicker";
import { SummaryModelPicker } from "./SummaryModelPicker";
import { ProviderCard } from "./ProviderCard";
import { ProviderForm } from "./ProviderForm";

export function ModelsSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const [editing, setEditing] = useState<ProviderDto | null | "new">(null); // null=无, "new"=新建, dto=编辑

  const remove = useMutation({
    mutationFn: (id: string) => window.api.settings.providers.remove({ id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.providers }),
  });

  return (
    <section className="space-y-6">
      <h2 className="font-serif text-lg">{t("settings.models", "模型")}</h2>
      <AssistantModelPicker />
      <SummaryModelPicker />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {t("settings.provider.title", "$t(terms.provider)")}
          </h3>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> {t("settings.provider.add", "添加$t(terms.provider)")}
          </Button>
        </div>
        {editing === "new" && <ProviderForm provider={null} onDone={() => setEditing(null)} />}
        {providers.data?.map((p) =>
          editing !== "new" && editing?.id === p.id ? (
            <ProviderForm key={p.id} provider={p} onDone={() => setEditing(null)} />
          ) : (
            <ProviderCard
              key={p.id}
              provider={p}
              onEdit={() => setEditing(p)}
              onRemove={() => remove.mutate(p.id)}
            />
          ),
        )}
      </div>
    </section>
  );
}
