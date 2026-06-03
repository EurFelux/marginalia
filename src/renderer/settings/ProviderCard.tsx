import { Pencil, PlugZap, Trash2 } from "lucide-react";
import type { ProviderDto } from "@shared/providers";
import { PROVIDER_TYPE_LABEL } from "@shared/providers";
import { Button } from "@renderer/components/ui/button";

function keyText(p: ProviderDto): string {
  if (p.key.status === "set") return p.key.mask;
  if (p.key.status === "undecryptable") return "本机无法解密";
  return "未配置";
}

export function ProviderCard({
  provider,
  onEdit,
  onTest,
  onRemove,
}: {
  provider: ProviderDto;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
            {PROVIDER_TYPE_LABEL[provider.type]}
          </span>
          <span className="ml-2 text-sm font-medium">{provider.label ?? "（未命名）"}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="编辑">
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onTest} aria-label="测试">
            <PlugZap className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="移除">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {provider.baseUrl && <div className="truncate">⛓ {provider.baseUrl}</div>}
        <span>🔑 {keyText(provider)}</span>
        <span className="ml-2">· {provider.models.length} 个模型</span>
      </div>
    </div>
  );
}
