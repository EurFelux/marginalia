import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ProviderIcon } from "@lobehub/icons";
import { Check, Pencil, PlugZap, Trash2, X } from "lucide-react";
import type { ProviderDto } from "@shared/providers";
import { PROVIDER_TYPE_LABEL } from "@shared/providers";
import { Button } from "@renderer/components/ui/button";

/** 内置 provider 的 label → @lobehub/icons 品牌 key（仅内置显示图标；label 内置不可改，是稳定身份）。 */
const BRAND_KEY: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Gemini: "google", // ProviderIcon 的 provider key 是 "google"（"gemini" 是 model 级、ProviderIcon 不认）
  DeepSeek: "deepseek", // provider 级映射存在（providerConfig keywords:[ModelProvider.DeepSeek]）
};

function keyText(p: ProviderDto): string {
  if (p.key.status === "set") return p.key.mask;
  if (p.key.status === "undecryptable") return "本机无法解密";
  return "未配置";
}

/**
 * 单个 provider 卡片。测试连接是**卡片自有**状态（本地 mutation + 就地显示），不写共享 testResult——
 * 否则会和「对话模型」区的测试结果互相覆盖、显示串位（见 RA5 review）。无模型时禁用测试（避免空 model 触发后端校验错）。
 */
export function ProviderCard({
  provider,
  onEdit,
  onRemove,
}: {
  provider: ProviderDto;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const test = useMutation({
    mutationFn: () =>
      window.api.settings.providers.test({ id: provider.id, model: provider.models[0] ?? "" }),
    onSuccess: (r) => setResult(r.ok ? { ok: true } : { ok: false, message: r.message }),
    onError: (e) => setResult({ ok: false, message: (e as Error).message }),
  });

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* 内置 provider 显示品牌图标（@lobehub/icons；provider key = 我们的 type）。 */}
          {provider.isBuiltin && provider.label && BRAND_KEY[provider.label] && (
            <ProviderIcon provider={BRAND_KEY[provider.label]} type="color" size={18} />
          )}
          <span className="truncate text-sm font-medium">{provider.label ?? "（未命名）"}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {PROVIDER_TYPE_LABEL[provider.type]}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="编辑">
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => test.mutate()}
            disabled={provider.models.length === 0 || test.isPending}
            aria-label="测试连接"
            title={provider.models.length === 0 ? "先添加模型再测试" : "测试连接"}
          >
            <PlugZap className="size-4" />
          </Button>
          {!provider.isBuiltin && (
            <Button variant="ghost" size="sm" onClick={onRemove} aria-label="移除">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        <span>🔑 {keyText(provider)}</span>
        <span className="ml-2">· {provider.models.length} 个模型</span>
      </div>
      {(test.isPending || result) && (
        <p
          className={
            test.isPending
              ? "mt-1 text-xs text-muted-foreground"
              : result?.ok
                ? "mt-1 flex items-center gap-1 text-xs text-primary"
                : "mt-1 flex items-center gap-1 text-xs text-destructive"
          }
        >
          {test.isPending ? (
            "测试中…"
          ) : result?.ok ? (
            <>
              <Check className="size-3.5" /> 连接成功
            </>
          ) : (
            <>
              <X className="size-3.5" /> 失败：{result?.message ?? ""}
            </>
          )}
        </p>
      )}
    </div>
  );
}
