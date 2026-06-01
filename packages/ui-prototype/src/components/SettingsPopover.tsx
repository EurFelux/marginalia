import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "#/components/ui/button";
import { useReaderAI } from "#/reader-ai-context";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** 顶栏齿轮按钮 + 阅读设置 popover（字号 / 行距 / 宽度）。轻量自实现，点击外部关闭。 */
export function SettingsPopover() {
  const { t } = useTranslation();
  const { prefs, updatePrefs } = useReaderAI();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("settings.title")}
      >
        <Settings className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-border bg-popover p-3 font-sans text-sm shadow-lg">
          <div className="mb-2.5 text-xs font-semibold text-foreground">{t("settings.title")}</div>
          <div className="space-y-1.5">
            <Row
              label={t("settings.fontSize")}
              value={`${Math.round(prefs.fontScale * 100)}%`}
              onDec={() => updatePrefs({ fontScale: clamp(prefs.fontScale - 0.05, 0.8, 1.5) })}
              onInc={() => updatePrefs({ fontScale: clamp(prefs.fontScale + 0.05, 0.8, 1.5) })}
            />
            <Row
              label={t("settings.lineHeight")}
              value={prefs.lineHeight.toFixed(1)}
              onDec={() => updatePrefs({ lineHeight: clamp(prefs.lineHeight - 0.1, 1.4, 2.4) })}
              onInc={() => updatePrefs({ lineHeight: clamp(prefs.lineHeight + 0.1, 1.4, 2.4) })}
            />
            <Row
              label={t("settings.width")}
              value={`${prefs.maxWidth}`}
              onDec={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth - 40, 480, 820) })}
              onInc={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth + 40, 480, 820) })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
        <button
          type="button"
          onClick={onDec}
          className="grid size-5 place-items-center rounded hover:bg-muted"
          aria-label={t("settings.decrease", { label })}
        >
          <Minus className="size-3" />
        </button>
        <span className="w-10 text-center text-xs tabular-nums text-foreground">{value}</span>
        <button
          type="button"
          onClick={onInc}
          className="grid size-5 place-items-center rounded hover:bg-muted"
          aria-label={t("settings.increase", { label })}
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
}
