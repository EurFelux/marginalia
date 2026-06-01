import { useCallback } from "react";
import { useReaderStore } from "@renderer/store/reader-store";

export type PresetId = "explain" | "translate" | "summarize";

const PRESET_PROMPT: Record<PresetId, string> = {
  explain: "请解释选中的这段内容。",
  translate: "请把选中的这段内容翻译成简体中文。",
  summarize: "请概括选中的这段内容。",
};

export function useAiActions() {
  const startAiAction = useCallback(async (preset: PresetId | null) => {
    const { selection, setDraftChips, setDraftText, setPanelOpen, setSelection } =
      useReaderStore.getState();
    if (!selection) return;
    const chips = await window.api.ai.buildChips({
      selection: selection.selectionText,
      paragraphBefore: selection.paragraphBefore,
      paragraphCurrent: selection.paragraphCurrent,
      paragraphAfter: selection.paragraphAfter,
    });
    setDraftChips(chips);
    setDraftText(preset ? PRESET_PROMPT[preset] : "");
    setPanelOpen(true);
    setSelection(null); // 收起工具栏
  }, []);

  return { startAiAction };
}
