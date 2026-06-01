import type { ReactNode } from "react";
import { BookOpen, FileText, Languages, Sparkles } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { useReaderStore } from "@renderer/store/reader-store";
import { useAiActions, type PresetId } from "@renderer/ai/use-ai-actions";

const PRESETS: { id: PresetId; label: string; icon: typeof BookOpen }[] = [
  { id: "explain", label: "解释", icon: BookOpen },
  { id: "translate", label: "翻译", icon: Languages },
  { id: "summarize", label: "概括", icon: FileText },
];

export function SelectionToolbar() {
  const selection = useReaderStore((s) => s.selection);
  const { startAiAction } = useAiActions();
  if (!selection || !selection.rect) return null;

  const { rect } = selection;
  const PAD = 200;
  const left = Math.min(Math.max(rect.x + rect.width / 2, PAD), window.innerWidth - PAD);
  const top = rect.y - 10;

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 50 }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn
        primary
        onClick={() => void startAiAction(null)}
        icon={<Sparkles className="size-3.5 text-primary" />}
        label="AI 问"
      />
      {PRESETS.map((p) => {
        const Icon = p.icon;
        return (
          <ToolBtn
            key={p.id}
            onClick={() => void startAiAction(p.id)}
            icon={<Icon className="size-3.5" />}
            label={p.label}
          />
        );
      })}
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
