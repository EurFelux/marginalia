import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AiProviderApiType, ProviderDto } from "@shared/providers";
import {
  aiProviderApiType,
  DEFAULT_BASE_URL,
  PROVIDER_TYPE_LABEL,
  resolveProviderBaseUrl,
} from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { ModelEditor } from "./ModelEditor";
import { providerFormToUpsertInput, type ProviderFormState } from "./settings-logic";

function initial(p: ProviderDto | null): ProviderFormState {
  return {
    id: p?.id,
    type: p?.type ?? "openai-responses",
    label: p?.label ?? "",
    // 内置 baseUrl 纯派生、不进表单态（DTO.baseUrl 已是派生值，塞进来保存时会触发「内置 baseUrl 不可改」误拒）。
    baseUrl: p?.isBuiltin ? "" : (p?.baseUrl ?? ""),
    apiKey: "",
    models: p?.models ?? [],
  };
}

export function ProviderForm({
  provider,
  onDone,
}: {
  provider: ProviderDto | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState<ProviderFormState>(() => initial(provider));
  const [editingKey, setEditingKey] = useState(provider == null || provider.keyMask === null);
  // 用户自建（非内置）必须填 baseUrl；内置走默认端点 / 工厂派生，免填。
  const baseRequired = !(provider?.isBuiltin ?? false);
  // 内置 provider：label/baseUrl 锁定（仅密钥 + 模型可改）。UI 防御，main 仓储也会拦。
  const locked = provider?.isBuiltin ?? false;
  // baseUrl 显示/消费值：内置按当前 type 派生（DeepSeek 两端点不同；其余内置为空走 placeholder），非内置用表单值。
  const displayBaseUrl =
    locked && provider ? (resolveProviderBaseUrl(provider, f.type) ?? "") : f.baseUrl;
  // type：非内置自由选（全部）；内置仅可在 compatibleApis 内切，单一则锁定。
  const compatibleApis = provider?.compatibleApis ?? aiProviderApiType.options;
  const typeOptions = provider?.isBuiltin ? compatibleApis : aiProviderApiType.options;
  const typeLocked = (provider?.isBuiltin ?? false) && compatibleApis.length <= 1;

  const save = useMutation({
    mutationFn: () => window.api.settings.providers.upsert(providerFormToUpsertInput(f)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.providers });
      onDone();
    },
  });

  // 名称必填；openai-compatible 还要求 baseUrl（内置 DeepSeek 走派生值，故用 displayBaseUrl 判定）。
  const canSave = f.label.trim().length > 0 && !(baseRequired && !displayBaseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("settings.provider.type", "类型")}</span>
        <Select
          value={f.type}
          disabled={typeLocked}
          onValueChange={(v) => {
            if (v) setF({ ...f, type: v as AiProviderApiType });
          }}
        >
          <SelectTrigger className="h-9 w-full">
            {/* value 是 type 裸值（如 "openai-responses"）；用函数 child 映射成显示名。 */}
            <SelectValue>
              {(v) => (typeof v === "string" ? PROVIDER_TYPE_LABEL[v as AiProviderApiType] : null)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {PROVIDER_TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{t("settings.provider.name", "名称")}</span>
        <Input
          value={f.label}
          onChange={(e) => setF({ ...f, label: e.target.value })}
          disabled={locked}
          placeholder={t("settings.provider.namePlaceholder", "（必填）")}
        />
        <span className="text-xs text-muted-foreground">
          {t("settings.provider.baseUrl", "baseURL")}
        </span>
        <Input
          value={displayBaseUrl}
          onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
          disabled={locked}
          placeholder={
            DEFAULT_BASE_URL[f.type] ??
            t("settings.provider.baseUrlPlaceholder", "https://你的网关/v1（必填）")
          }
        />
        <span className="text-xs text-muted-foreground">
          {t("settings.provider.apiKey", "API Key")}
        </span>
        {!editingKey && provider && provider.keyMask !== null ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-sm text-muted-foreground">
              {provider.keyMask}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
              {t("common.edit", "编辑")}
            </Button>
          </div>
        ) : (
          <Input
            type="password"
            value={f.apiKey}
            onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            placeholder="sk-…"
          />
        )}
      </div>
      <ModelEditor
        models={f.models}
        onChange={(models) => setF({ ...f, models })}
        type={f.type}
        baseUrl={displayBaseUrl}
        apiKey={f.apiKey}
        id={f.id}
      />
      {save.isError && (
        <p className="text-xs text-destructive">
          {t("settings.provider.saveFailed", "保存失败：{{message}}", {
            message: (save.error as Error).message,
          })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("common.cancel", "取消")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("common.saving", "保存中…") : t("common.save", "保存")}
        </Button>
      </div>
    </div>
  );
}
