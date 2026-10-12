import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useChatStore } from "@renderer/store/chat-store";
import { openPanelAndFocusComposer, submitComposer } from "@renderer/ai/composer-focus";
import { toast } from "sonner";
import i18n from "@renderer/i18n";
import { isBlockedWhileReplying, planSelectionAction } from "@renderer/ai/ai-action-draft";
import type { SelectionActionView } from "@shared/selection-actions";

/** 执行一个划词指令：选区生成上下文 chip → 按 planSelectionAction 填入 / 直接发送 → 收起工具栏。 */
async function startAiAction(action: SelectionActionView): Promise<void> {
  const { selection, setSelection } = useAnnotationStore.getState();
  const { setDraftChips, setDraftText } = useChatStore.getState();
  if (!selection) return;
  // AI 正在回复时直接发送不可用（工具栏已置灰；这里兜住刚好开始回复的瞬间）：不发、不动输入框。
  const busyHint = () =>
    toast.info(i18n.t("reader.selection.busy", "AI 正在回复，等这轮回复结束再用"));
  if (isBlockedWhileReplying(action, useChatStore.getState().aiReplying)) {
    busyHint();
    return;
  }
  const chips = await window.api.ai.buildChips({
    selection: selection.selectionText,
    paragraphBefore: selection.paragraphBefore,
    paragraphCurrent: selection.paragraphCurrent,
    paragraphAfter: selection.paragraphAfter,
  });
  const plan = planSelectionAction(action);
  openPanelAndFocusComposer();
  // 直接发送：走 Composer 的发送路径，选区 chip 随这条发出、不进草稿，也不动读者写到一半的草稿文字。
  if (plan === "send") {
    if (submitComposer(action.prompt, chips)) setSelection(null);
    else busyHint();
    return;
  }
  setDraftChips(chips);
  if (plan !== "keepDraft") setDraftText(action.prompt);
  setSelection(null); // 收起工具栏
}

export function useAiActions() {
  return { startAiAction };
}
