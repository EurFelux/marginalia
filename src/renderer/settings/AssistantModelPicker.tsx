import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { PROVIDER_TYPE_LABEL } from "@shared/providers";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useSettingsStore } from "@renderer/store/settings-store";
import { assistantModelOptions } from "./settings-logic";

export function AssistantModelPicker() {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
  });
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
  });
  const testResult = useSettingsStore((s) => s.testResult);
  const setTestResult = useSettingsStore((s) => s.setTestResult);

  const providerId = assistant.data?.providerId ?? "";
  const model = assistant.data?.model ?? "";
  const selected = providers.data?.find((p) => p.id === providerId) ?? null;
  const modelOptions = assistantModelOptions(selected?.models ?? [], model || null);

  const save = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string | null }) =>
      window.api.settings.assistant.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assistantDefault }),
  });
  const test = useMutation({
    mutationFn: () => window.api.settings.providers.test({ id: providerId, model }),
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">对话模型</h3>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">Provider</span>
        <Select
          value={providerId || null}
          onValueChange={(id) => {
            // 切 provider 同时清 model（旧 model 多半不属于新 provider）：显 placeholder 强制重选，
            // 避免残留出非法 (provider, model) 对让测试/对话失败。换选后旧测试结果作废。
            if (id) {
              save.mutate({ providerId: id, model: null });
              setTestResult(null);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择 provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {PROVIDER_TYPE_LABEL[p.type]} · {p.label ?? "（未命名）"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">模型</span>
        <Select
          value={model || null}
          onValueChange={(m) => {
            if (m) {
              save.mutate({ model: m });
              setTestResult(null);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!providerId || !model || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "测试中…" : "测试连接"}
        </Button>
        {testResult && (
          <span
            className={
              testResult.ok
                ? "flex items-center gap-1 text-sm text-primary"
                : "flex items-center gap-1 text-sm text-destructive"
            }
          >
            {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
            {testResult.ok ? "连接成功" : `失败：${testResult.message ?? ""}`}
          </span>
        )}
      </div>
    </section>
  );
}
