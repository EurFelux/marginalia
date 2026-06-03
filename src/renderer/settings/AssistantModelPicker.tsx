import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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

  const unnamed = t("settings.provider.unnamed", "（未命名）");

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t("settings.assistantModel", "对话模型")}</h3>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("terms.provider")}</span>
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
          <SelectTrigger className="h-9 w-full">
            {/* value 是 provider id（uuid）；Base UI Select.Value 默认渲染裸 value，故用函数 child 映射成名字。 */}
            <SelectValue placeholder={t("settings.provider.select", "选择$t(terms.provider)")}>
              {(value) =>
                typeof value === "string"
                  ? (providers.data?.find((p) => p.id === value)?.label ?? unnamed)
                  : t("settings.provider.select", "选择$t(terms.provider)")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label ?? unnamed}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{t("settings.model", "模型")}</span>
        <Select
          value={model || null}
          disabled={!providerId}
          onValueChange={(m) => {
            if (m) {
              save.mutate({ model: m });
              setTestResult(null);
            }
          }}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue placeholder={t("settings.model.select", "选择模型")} />
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
          {test.isPending
            ? t("settings.provider.testing", "测试中…")
            : t("settings.provider.test", "测试连接")}
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
            {testResult.ok
              ? t("settings.provider.testOk", "连接成功")
              : t("settings.provider.testFail", "失败：{{message}}", {
                  message: testResult.message ?? "",
                })}
          </span>
        )}
      </div>
    </section>
  );
}
