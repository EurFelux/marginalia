import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AiProviderApiType, ProviderDto } from "@shared/providers";
import { aiProviderApiType, DEFAULT_BASE_URL, PROVIDER_TYPE_LABEL } from "@shared/providers";
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
    baseUrl: p?.baseUrl ?? "",
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
  const qc = useQueryClient();
  const [f, setF] = useState<ProviderFormState>(() => initial(provider));
  const [editingKey, setEditingKey] = useState(provider == null || provider.key.status === "none");
  const baseRequired = f.type === "openai-chat-completions";
  // 内置 provider：label/baseUrl 锁定（仅密钥 + 模型可改）。UI 防御，main 仓储也会拦。
  const locked = provider?.isBuiltin ?? false;
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

  // 名称必填；openai-compatible 还要求 baseUrl。
  const canSave = f.label.trim().length > 0 && !(baseRequired && !f.baseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">类型</span>
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
        <span className="text-xs text-muted-foreground">名称</span>
        <Input
          value={f.label}
          onChange={(e) => setF({ ...f, label: e.target.value })}
          disabled={locked}
          placeholder="（必填）"
        />
        <span className="text-xs text-muted-foreground">baseURL</span>
        <Input
          value={f.baseUrl}
          onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
          disabled={locked}
          placeholder={DEFAULT_BASE_URL[f.type] ?? "https://你的网关/v1（必填）"}
        />
        <span className="text-xs text-muted-foreground">API Key</span>
        {!editingKey && provider && provider.key.status !== "none" ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-sm text-muted-foreground">
              {provider.key.status === "set" ? provider.key.mask : "本机无法解密"}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
              编辑
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
      {locked && (
        <p className="text-[11px] text-muted-foreground">
          内置 provider：名称 / baseURL 不可改（密钥、模型可编辑）。
        </p>
      )}
      <ModelEditor
        models={f.models}
        onChange={(models) => setF({ ...f, models })}
        type={f.type}
        baseUrl={f.baseUrl}
        apiKey={f.apiKey}
        id={f.id}
      />
      {save.isError && (
        <p className="text-xs text-destructive">保存失败：{(save.error as Error).message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
