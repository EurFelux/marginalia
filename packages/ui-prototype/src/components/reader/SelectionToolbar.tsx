import type { ReactNode } from "react";
import {
  BookOpen,
  Copy,
  FileText,
  Languages,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PresetId } from "#/mock/types";
import { PRESETS } from "#/mock/fixtures";
import { HIGHLIGHT, HIGHLIGHT_COLORS } from "#/highlight";
import { useReaderAI } from "#/reader-ai-context";
import { cn } from "#/lib/utils";

const PRESET_ICON: Record<PresetId, LucideIcon> = {
  explain: BookOpen,
  translate: Languages,
  summarize: FileText,
};

/** 选区上方的浮动工具栏（fixed 定位到选区指针）。 */
export function SelectionToolbar() {
  const { t } = useTranslation();
  const { selection, startAiAction, addAnnotation, openHighlightPopover } = useReaderAI();
  if (!selection) return null;

  const { anchor } = selection;
  const PAD = 220;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const left = Math.min(Math.max(anchor.x, PAD), vw - PAD);
  const above = anchor.y > 96;
  const copy = () => void navigator.clipboard?.writeText(selection.selectionText);
  const note = () => {
    const at = anchor; // addAnnotation 会清空选区，先存锚点
    const id = addAnnotation("yellow");
    if (id) openHighlightPopover(id, at.x, at.y, true);
  };

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left,
        top: above ? anchor.y - 12 : anchor.y + 18,
        transform: `translate(-50%, ${above ? "-100%" : "0"})`,
        zIndex: 50,
      }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn onClick={copy} icon={<Copy className="size-3.5" />} label={t("toolbar.copy")} />
      <span className="mx-0.5 h-5 w-px bg-border" />
      <ToolBtn
        primary
        onClick={() => startAiAction(null)}
        icon={<Sparkles className="size-3.5 text-primary" />}
        label={t("toolbar.aiAsk")}
      />
      {PRESETS.map((p) => {
        const Icon = PRESET_ICON[p.id];
        return (
          <ToolBtn
            key={p.id}
            onClick={() => startAiAction(p.id)}
            icon={<Icon className="size-3.5" />}
            label={t(`preset.${p.id}`)}
          />
        );
      })}
      <span className="mx-0.5 h-5 w-px bg-border" />
      <div className="flex items-center gap-1 px-1">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t("toolbar.highlight", { color: t(`color.${c}`) })}
            onClick={() => addAnnotation(c)}
            className={cn("size-4 rounded-full transition hover:scale-110", HIGHLIGHT[c].swatch)}
          />
        ))}
      </div>
      <ToolBtn
        onClick={note}
        icon={<StickyNote className="size-3.5" />}
        label={t("toolbar.note")}
      />
    </div>
  );
}

function ToolBtn({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-muted",
        primary && "text-primary",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
