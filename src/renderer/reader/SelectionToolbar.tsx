import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Highlighter, Languages, Sparkles, StickyNote } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useAiActions, type PresetId } from "@renderer/ai/use-ai-actions";

const PRESETS: { id: PresetId; icon: typeof BookOpen }[] = [
  { id: "explain", icon: BookOpen },
  { id: "translate", icon: Languages },
  { id: "summarize", icon: FileText },
];

export function SelectionToolbar() {
  const { t } = useTranslation();
  const selection = useAnnotationStore((s) => s.selection);
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const openNoteModal = useAnnotationStore((s) => s.openNoteModal);
  const setSelection = useAnnotationStore((s) => s.setSelection);
  const styleBar = useAnnotationStore((s) => s.styleBar);
  const noteModal = useAnnotationStore((s) => s.noteModal);
  const bookId = useNavigationStore((s) => s.currentBookId);
  const lastStyle = usePrefsStore((s) => s.lastHighlightStyle);
  const { startAiAction } = useAiActions();
  const qc = useQueryClient();
  const createM = useMutation({
    mutationFn: window.api.annotations.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") }),
  });
  // 二级工具栏（样式栏）/ 笔记 modal 打开时，主工具栏让位消失（Apple Books 式取代，
  // 而非叠层）。选区仍保留在 store 里，供样式栏/modal 读取 cfiRange/selectedText。
  if (styleBar || noteModal) return null;
  if (!selection || !selection.rect) return null;

  const { rect } = selection;
  const PAD = 220;
  const left = Math.min(Math.max(rect.x + rect.width / 2, PAD), window.innerWidth - PAD);
  const top = rect.y - 10;

  // 选「高亮标记」：立即用上次的样式建高亮（Apple Books 式，无需先选色），再打开该条的样式栏供改色；
  // 滚动 / 点别处则关栏、高亮保留。
  const applyHighlight = () => {
    if (!bookId || !selection.cfiRange || !selection.selectionText) return;
    createM.mutate(
      {
        bookId,
        style: lastStyle,
        note: "",
        selectedText: selection.selectionText,
        cfiRange: selection.cfiRange,
      },
      {
        onSuccess: (anno) =>
          openStyleBar({ rect, target: { type: "edit", annotationId: anno.id } }),
      },
    );
    setSelection(null);
  };

  // 选「添加笔记」：把选区锚点（cfiRange/selectedText）快照进 modal，使 save 不依赖易失的 selection。
  const addNote = () => {
    if (!selection.cfiRange || !selection.selectionText) return;
    openNoteModal({
      target: { type: "create" },
      anchor: { cfiRange: selection.cfiRange, selectedText: selection.selectionText },
    });
  };

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 50 }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn
        onClick={applyHighlight}
        icon={<Highlighter className="size-3.5" />}
        label={t("reader.selection.highlight", "高亮标记")}
      />
      <ToolBtn
        onClick={addNote}
        icon={<StickyNote className="size-3.5" />}
        label={t("reader.selection.addNote", "添加笔记")}
      />
      <span className="mx-0.5 h-5 w-px bg-border" />
      <ToolBtn
        primary
        onClick={() => void startAiAction(null)}
        icon={<Sparkles className="size-3.5 text-primary" />}
        label={t("reader.selection.askAi", "AI 问")}
      />
      {PRESETS.map((p) => {
        const Icon = p.icon;
        const label =
          p.id === "explain"
            ? t("reader.selection.explain", "解释")
            : p.id === "translate"
              ? t("reader.selection.translate", "翻译")
              : t("reader.selection.summarize", "概括");
        return (
          <ToolBtn
            key={p.id}
            onClick={() => void startAiAction(p.id)}
            icon={<Icon className="size-3.5" />}
            label={label}
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
    <Button variant="ghost" size="sm" onClick={onClick} className={cn(primary && "text-primary")}>
      {icon}
      <span>{label}</span>
    </Button>
  );
}
