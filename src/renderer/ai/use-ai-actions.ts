import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useChatStore } from "@renderer/store/chat-store";
import { openPanelAndFocusComposer, submitComposer } from "@renderer/ai/composer-focus";
import { planSelectionAction } from "@renderer/ai/ai-action-draft";
import type { SelectionActionView } from "@shared/selection-actions";

/** 执行一个划词指令：选区生成上下文 chip → 按 planSelectionAction 填入 / 直接发送 → 收起工具栏。 */
async function startAiAction(action: SelectionActionView): Promise<void> {
  const { selection, setSelection } = useAnnotationStore.getState();
  const { setDraftChips, setDraftText } = useChatStore.getState();
  if (!selection) return;
  const chips = await window.api.ai.buildChips({
    selection: selection.selectionText,
    paragraphBefore: selection.paragraphBefore,
    paragraphCurrent: selection.paragraphCurrent,
    paragraphAfter: selection.paragraphAfter,
  });
  const plan = planSelectionAction(action);
  openPanelAndFocusComposer();
  // 直接发送：走 Composer 的发送路径，选区 chip 随这条发出、不进草稿，也不动读者写到一半的草稿文字。
  // AI 正在回复时发不出去 → 退回「填入」。
  if (plan === "send" && submitComposer(action.prompt, chips)) {
    setSelection(null);
    return;
  }
  setDraftChips(chips);
  if (plan !== "keepDraft") setDraftText(action.prompt);
  setSelection(null); // 收起工具栏
}

export function useAiActions() {
  return { startAiAction };
}
