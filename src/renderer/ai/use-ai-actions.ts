import { useCallback } from "react";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useChatStore } from "@renderer/store/chat-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import i18n from "@renderer/i18n";

export type PresetId = "explain" | "translate" | "summarize";

/** 按 preset 取本地化的预设提示语（调用时求值，跟随 UI 语言）。 */
function resolvePresetPrompt(preset: PresetId): string {
  switch (preset) {
    case "explain":
      return i18n.t("ai.action.explain", "请解释选中的这段内容。");
    case "translate":
      return i18n.t("ai.action.translate", "请把选中的这段内容翻译成简体中文。");
    case "summarize":
      return i18n.t("ai.action.summarize", "请概括选中的这段内容。");
  }
}

export function useAiActions() {
  const startAiAction = useCallback(async (preset: PresetId | null) => {
    const { selection, setSelection } = useAnnotationStore.getState();
    const { setDraftChips, setDraftText } = useChatStore.getState();
    if (!selection) return;
    // 不同章划词 = 进入无 active 状态（不建会话——会话只在 send 时由 routeConversation 创建）。
    // active 为独立会话（chapter null）或同章时不清，照常追加。
    const { activeConversationId, activeConversationChapterId, setActiveConversation } =
      useChatStore.getState();
    const { currentChapterId } = useNavigationStore.getState();
    if (
      activeConversationId &&
      activeConversationChapterId !== null &&
      currentChapterId &&
      activeConversationChapterId !== currentChapterId
    ) {
      setActiveConversation(null);
    }
    const chips = await window.api.ai.buildChips({
      selection: selection.selectionText,
      paragraphBefore: selection.paragraphBefore,
      paragraphCurrent: selection.paragraphCurrent,
      paragraphAfter: selection.paragraphAfter,
    });
    setDraftChips(chips);
    setDraftText(preset ? resolvePresetPrompt(preset) : "");
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    setSelection(null); // 收起工具栏
  }, []);

  return { startAiAction };
}
