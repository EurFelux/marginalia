import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chip } from "@shared/chat";
import { chipLabel } from "@renderer/ai/chip-label";

interface HoverState {
  chip: Chip;
  rect: DOMRect;
}

export function ChipBar({ chips }: { chips: Chip[] }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HoverState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHover(null), 160);
  };

  if (chips.length === 0) return null;

  return (
    <div className="flex gap-1.5">
      {chips.map((chip) => (
        <div
          key={chip.id}
          onMouseEnter={(e) => {
            cancelClose();
            setHover({ chip, rect: e.currentTarget.getBoundingClientRect() });
          }}
          onMouseLeave={scheduleClose}
          className="min-w-0 flex-1 cursor-default rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{chipLabel(chip)}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              ≈{chip.tokenCount} {t("ai.tokUnit", "tok")}
            </span>
            {chip.required && <Lock className="ms-auto size-3 shrink-0 text-muted-foreground/70" />}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{chip.content}</div>
        </div>
      ))}
      {hover && (
        <ChipPopover
          chip={hover.chip}
          rect={hover.rect}
          label={chipLabel(hover.chip)}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </div>
  );
}

function ChipPopover({
  chip,
  rect,
  label,
  onEnter,
  onLeave,
}: {
  chip: Chip;
  rect: DOMRect;
  label: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  if (typeof document === "undefined") return null;
  const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 320 - 12);
  const bottom = window.innerHeight - rect.top + 8; // 底边贴卡片顶上方 8px，向上生长

  return createPortal(
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "fixed", left, bottom, zIndex: 60 }}
      className="max-h-40 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed shadow-xl"
    >
      <div className="mb-1 font-medium text-foreground">
        {t("ai.chip.willSend", "将发送")} · {label}
      </div>
      <p className="whitespace-pre-wrap text-muted-foreground">{chip.content}</p>
      {chip.required && (
        <div className="mt-2 text-[11px] text-muted-foreground/70">
          {t("ai.chip.requiredContext", "必备上下文，随消息一并发送。")}
        </div>
      )}
    </div>,
    document.body,
  );
}
