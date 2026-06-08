import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { createLogger } from "@renderer/logger";

const log = createLogger("ai");
const COPIED_RESET_MS = 1500;

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 命令式 effect 清理仍手写（React Compiler 不接管）：卸载时清未触发的复位定时器。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      log.warn("copy to clipboard failed", err); // 优雅吞错处留 warn
      return; // 失败不进「已复制」态
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t("ai.copied", "已复制") : t("ai.copy", "复制")}
      onClick={onCopy}
      className="text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
