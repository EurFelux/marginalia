import { useTranslation } from "react-i18next";
import { Minus, Plus, Type } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useReaderStore } from "@renderer/store/reader-store";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

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
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDec}
          aria-label={t("reader.prefs.decrease", "减小{{label}}", { label })}
        >
          <Minus />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums">{value}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onInc}
          aria-label={t("reader.prefs.increase", "增大{{label}}", { label })}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

export function ReaderPrefs() {
  const { t } = useTranslation();
  const prefs = useReaderStore((s) => s.prefs);
  const updatePrefs = useReaderStore((s) => s.updatePrefs);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-label={t("reader.prefs.title", "阅读偏好")}
          />
        }
      >
        <Type />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60 space-y-2">
        <Row
          label={t("reader.prefs.fontSize", "字号")}
          value={`${Math.round(prefs.fontScale * 100)}%`}
          onDec={() => updatePrefs({ fontScale: round2(clamp(prefs.fontScale - 0.05, 0.8, 1.5)) })}
          onInc={() => updatePrefs({ fontScale: round2(clamp(prefs.fontScale + 0.05, 0.8, 1.5)) })}
        />
        <Row
          label={t("reader.prefs.lineHeight", "行距")}
          value={prefs.lineHeight.toFixed(1)}
          onDec={() => updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight - 0.1, 1.4, 2.4)) })}
          onInc={() => updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight + 0.1, 1.4, 2.4)) })}
        />
        <Row
          label={t("reader.prefs.columnWidth", "栏宽")}
          value={`${prefs.maxWidth}px`}
          onDec={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth - 40, 480, 820) })}
          onInc={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth + 40, 480, 820) })}
        />
      </PopoverContent>
    </Popover>
  );
}
