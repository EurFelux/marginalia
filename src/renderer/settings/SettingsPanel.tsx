import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useSettingsStore } from "@renderer/store/settings-store";
import { usePrefsStore } from "@renderer/store/prefs-store";

export function SettingsPanel() {
  const open = useSettingsStore((s) => s.open);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const testResult = useSettingsStore((s) => s.testResult);
  const setTestResult = useSettingsStore((s) => s.setTestResult);
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const setAutoSummarize = usePrefsStore((s) => s.setAutoSummarize);
  const qc = useQueryClient();

  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: () => window.api.settings.providers.list(),
    enabled: open,
  });
  const assistant = useQuery({
    queryKey: qk.assistantDefault,
    queryFn: () => window.api.settings.assistant.getDefault(),
    enabled: open,
  });

  const anthropic = providers.data?.find((p) => p.type === "anthropic") ?? null;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-3-5-haiku-latest");
  // 有 key 时默认展示掩码（只读）；点「编辑」才切到输入框换新 key。
  const [editingKey, setEditingKey] = useState(false);

  // 回填已保存的默认模型，避免每次打开都被重置成占位默认。
  // 用户改后、保存前不会被覆盖：assistant.data 仅在 save 成功失效后才重取。
  useEffect(() => {
    if (assistant.data) setModel(assistant.data.model ?? "claude-3-5-haiku-latest");
  }, [assistant.data]);

  const save = useMutation({
    mutationFn: async () => {
      const prov = await window.api.settings.providers.upsert({
        id: anthropic?.id,
        type: "anthropic",
        apiKey: apiKey.trim() || undefined,
      });
      await window.api.settings.assistant.update({ providerId: prov.id, model: model.trim() });
    },
    onSuccess: () => {
      setApiKey("");
      setEditingKey(false);
      setTestResult(null);
      void qc.invalidateQueries({ queryKey: qk.providers });
      void qc.invalidateQueries({ queryKey: qk.assistantDefault });
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      if (!anthropic) throw new Error("请先保存 provider（填写 API Key 并保存）");
      return window.api.settings.providers.test({ id: anthropic.id, model: model.trim() });
    },
    onSuccess: (r) => setTestResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  if (!open) return null;

  const canSave = apiKey.trim().length > 0 || anthropic != null;

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="font-sans sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle className="font-serif text-lg">设置</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">API Key</span>
            {anthropic && anthropic.key.status !== "none" && !editingKey ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground">
                  {anthropic.key.status === "set" ? anthropic.key.mask : "已配置（本机无法解密）"}
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                  编辑
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-…"
                />
                {anthropic && anthropic.key.status !== "none" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingKey(false);
                      setApiKey("");
                    }}
                  >
                    取消
                  </Button>
                )}
              </div>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">模型</span>
            <Input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-3-5-haiku-latest"
            />
          </label>

          {assistant.data && (
            <p className="text-[11px] text-muted-foreground">
              当前默认：provider {assistant.data.providerId ?? "（未设）"} · model{" "}
              {assistant.data.model ?? "（未设）"}
            </p>
          )}

          {save.isError && (
            <p className="text-sm text-destructive">保存失败：{(save.error as Error).message}</p>
          )}
          {testResult && (
            <p
              className={
                testResult.ok
                  ? "flex items-center gap-1.5 text-sm text-primary"
                  : "flex items-center gap-1.5 text-sm text-destructive"
              }
            >
              {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
              {testResult.ok ? "连接成功" : `连接失败：${testResult.message ?? ""}`}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending || !anthropic}
            >
              {test.isPending ? "测试中…" : "测试连接"}
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>

          <div className="mt-1 flex items-start justify-between gap-3 border-t border-border pt-3">
            <label htmlFor="auto-summarize" className="min-w-0 cursor-pointer">
              <span className="block text-sm font-medium">开章自动生成本章摘要</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                打开 / 切换章节时后台生成本章摘要，就绪后随提问一并提供给
                AI（会产生模型调用）。关闭时可在 AI 面板的摘要 pill 里手动生成。
              </span>
            </label>
            <Checkbox
              id="auto-summarize"
              checked={autoSummarize}
              onCheckedChange={setAutoSummarize}
              className="mt-0.5"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
