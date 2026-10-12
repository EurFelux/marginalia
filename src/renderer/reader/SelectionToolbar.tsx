import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Highlighter, Send, StickyNote, type LucideIcon } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useAiActions } from "@renderer/ai/use-ai-actions";
import { useSelectionActionViews } from "@renderer/ai/use-selection-actions";
import { SELECTION_ACTION_ICON_COMPONENTS } from "@renderer/ai/selection-action-icons";
import { inlineCountFor, splitToolbarActions } from "@renderer/ai/selection-action-layout";
import type { SelectionActionView } from "@shared/selection-actions";
import type { SelectionInfo } from "@renderer/types";

/** 工具栏离窗口左右边缘的最小距离（px）。 */
const EDGE_GAP = 8;

export function SelectionToolbar() {
  const selection = useAnnotationStore((s) => s.selection);
  const styleBar = useAnnotationStore((s) => s.styleBar);
  const noteModal = useAnnotationStore((s) => s.noteModal);
  // 阅读器挂载即开始读指令列表（本组件常驻），工具栏弹出时不用等。
  const actions = useSelectionActionViews();
  // 二级工具栏（样式栏）/ 笔记 modal 打开时，主工具栏让位消失（Apple Books 式取代，
  // 而非叠层）。选区仍保留在 store 里，供样式栏/modal 读取 locatorRange/selectedText。
  if (styleBar || noteModal) return null;
  if (!selection || !selection.rect) return null;
  const { rect } = selection;
  // 以选区位置为 key：换一处选区即重挂，「更多」菜单的展开状态随之复位。
  return (
    <ToolbarPanel
      key={`${rect.x},${rect.y},${rect.width}`}
      selection={selection}
      rect={rect}
      actions={actions}
    />
  );
}

function ToolbarPanel({
  selection,
  rect,
  actions,
}: {
  selection: SelectionInfo;
  rect: NonNullable<SelectionInfo["rect"]>;
  actions: SelectionActionView[];
}) {
  const { t } = useTranslation();
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const openNoteModal = useAnnotationStore((s) => s.openNoteModal);
  const setSelection = useAnnotationStore((s) => s.setSelection);
  const bookId = useNavigationStore((s) => s.currentBookId);
  const lastStyle = usePrefsStore((s) => s.lastHighlightStyle);
  const showLabels = usePrefsStore((s) => s.selectionToolbarLabels);
  const { startAiAction } = useAiActions();
  const qc = useQueryClient();
  const createM = useMutation({
    mutationFn: window.api.annotations.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") }),
  });
  const [moreOpen, setMoreOpen] = useState(false);

  // 按实际宽度把工具栏夹在窗口内（指令文字长短不一，写死的估算宽度会出界）。
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    if (w !== width) setWidth(w);
  });
  const half = width / 2 + EDGE_GAP;
  const left = Math.min(Math.max(rect.x + rect.width / 2, half), window.innerWidth - half);
  const top = rect.y - 10;

  // 选「高亮标记」：立即用上次的样式建高亮（Apple Books 式，无需先选色），再打开该条的样式栏供改色；
  // 滚动 / 点别处则关栏、高亮保留。
  const applyHighlight = () => {
    if (!bookId || !selection.locatorRange || !selection.selectionText) return;
    createM.mutate(
      {
        bookId,
        style: lastStyle,
        note: "",
        selectedText: selection.selectionText,
        locatorRange: selection.locatorRange,
      },
      {
        onSuccess: (anno) =>
          openStyleBar({ rect, target: { type: "edit", annotationId: anno.id } }),
      },
    );
    setSelection(null);
  };

  // 选「添加笔记」：把选区锚点（locatorRange/selectedText）快照进 modal，使 save 不依赖易失的 selection。
  const addNote = () => {
    if (!selection.locatorRange || !selection.selectionText) return;
    openNoteModal({
      target: { type: "create" },
      anchor: { locatorRange: selection.locatorRange, selectedText: selection.selectionText },
    });
  };

  const { inline, overflow } = splitToolbarActions(actions, inlineCountFor(showLabels));

  return (
    <div
      ref={ref}
      // 阻止 mousedown 默认行为：点工具栏（含「更多」菜单）不清掉正文里的选区。
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 50 }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn
        showLabel={showLabels}
        onClick={applyHighlight}
        icon={Highlighter}
        label={t("reader.selection.highlight", "高亮标记")}
      />
      <ToolBtn
        showLabel={showLabels}
        onClick={addNote}
        icon={StickyNote}
        label={t("reader.selection.addNote", "添加笔记")}
      />
      {inline.length > 0 && <span className="mx-0.5 h-5 w-px bg-border" />}
      {inline.map((a) => (
        <ToolBtn
          key={a.id}
          showLabel={showLabels}
          primary={a.id === "ask"}
          onClick={() => void startAiAction(a)}
          icon={SELECTION_ACTION_ICON_COMPONENTS[a.icon]}
          label={a.label}
        />
      ))}
      {overflow.length > 0 && (
        <span className="relative">
          <ToolBtn
            showLabel={showLabels}
            active={moreOpen}
            ariaExpanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            icon={Ellipsis}
            label={t("reader.selection.more", "更多")}
          />
          {/* 菜单画在工具栏自身里（不挂到 body）：外层的 mousedown 拦截同样保住选区。 */}
          {moreOpen && (
            <div
              role="menu"
              className="absolute end-0 top-full mt-2 flex min-w-40 flex-col rounded-xl border border-border bg-popover p-1 shadow-lg"
            >
              {overflow.map((a) => (
                <MoreItem key={a.id} action={a} onClick={() => void startAiAction(a)} />
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/** 工具栏按钮：显示文字 = 图标 + 文字；只显示图标 = 图标按钮，悬停用 Tooltip 显示文字。 */
function ToolBtn({
  showLabel,
  icon: Icon,
  label,
  onClick,
  primary,
  active,
  ariaExpanded,
}: {
  showLabel: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  primary?: boolean;
  active?: boolean;
  ariaExpanded?: boolean;
}) {
  const className = cn(primary && "text-primary", active && "bg-accent");
  if (showLabel) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        aria-expanded={ariaExpanded}
        className={className}
      >
        <Icon className="size-3.5" />
        <span className="max-w-40 truncate">{label}</span>
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label={label}
            aria-expanded={ariaExpanded}
            className={className}
          >
            <Icon className="size-3.5" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MoreItem({ action, onClick }: { action: SelectionActionView; onClick: () => void }) {
  const Icon = SELECTION_ACTION_ICON_COMPONENTS[action.icon];
  const primary = action.id === "ask";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[0.8rem] hover:bg-accent",
        primary && "text-primary",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 max-w-48 flex-1 truncate">{action.label}</span>
      {action.autoSend && <Send className="size-3 shrink-0 text-muted-foreground" />}
    </button>
  );
}
