import { useState } from "react";
import { Minus, Plus, Type } from "lucide-react";
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
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1">
        <button
          onClick={onDec}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={`减小${label}`}
        >
          <Minus className="size-3" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{value}</span>
        <button
          onClick={onInc}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={`增大${label}`}
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
}

export function ReaderPrefs() {
  const prefs = useReaderStore((s) => s.prefs);
  const updatePrefs = useReaderStore((s) => s.updatePrefs);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-2 text-muted-foreground hover:bg-muted"
        aria-label="阅读偏好"
      >
        <Type className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-60 space-y-2 rounded-xl border border-border bg-popover p-3 shadow-xl">
          <Row
            label="字号"
            value={`${Math.round(prefs.fontScale * 100)}%`}
            onDec={() =>
              updatePrefs({ fontScale: round2(clamp(prefs.fontScale - 0.05, 0.8, 1.5)) })
            }
            onInc={() =>
              updatePrefs({ fontScale: round2(clamp(prefs.fontScale + 0.05, 0.8, 1.5)) })
            }
          />
          <Row
            label="行距"
            value={prefs.lineHeight.toFixed(1)}
            onDec={() =>
              updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight - 0.1, 1.4, 2.4)) })
            }
            onInc={() =>
              updatePrefs({ lineHeight: round2(clamp(prefs.lineHeight + 0.1, 1.4, 2.4)) })
            }
          />
          <Row
            label="栏宽"
            value={`${prefs.maxWidth}px`}
            onDec={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth - 40, 480, 820) })}
            onInc={() => updatePrefs({ maxWidth: clamp(prefs.maxWidth + 40, 480, 820) })}
          />
        </div>
      )}
    </div>
  );
}
