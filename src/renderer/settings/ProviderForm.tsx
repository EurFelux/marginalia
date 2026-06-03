import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderDto, ProviderType } from "@shared/providers";
import { DEFAULT_BASE_URL, PROVIDER_TYPE_LABEL, providerType } from "@shared/providers";
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
    type: p?.type ?? "openai",
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
  const baseRequired = f.type === "openai-compatible";

  const save = useMutation({
    mutationFn: () => window.api.settings.providers.upsert(providerFormToUpsertInput(f)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.providers });
      onDone();
    },
  });

  const canSave = !(baseRequired && !f.baseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">类型</span>
        <Select
          value={f.type}
          onValueChange={(v) => {
            if (v) setF({ ...f, type: v as ProviderType });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerType.options.map((t) => (
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
          placeholder="（可选）"
        />
        <span className="text-xs text-muted-foreground">baseURL</span>
        <Input
          value={f.baseUrl}
          onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
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
