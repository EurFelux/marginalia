import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { qk } from "@renderer/query/keys";
import {
  FACTORY_SELECTION_ACTIONS,
  resolveSelectionAction,
  type BuiltinSelectionActionId,
  type BuiltinSelectionDefaults,
} from "@shared/selection-actions";

/** 内置指令的出厂文字与默认提示语（跟随当前界面语言）。「询问」没有默认提示语。 */
export function builtinSelectionDefaults(t: TFunction): BuiltinSelectionDefaults {
  return {
    label: (id: BuiltinSelectionActionId) => {
      switch (id) {
        case "ask":
          return t("reader.selection.askAi", "询问");
        case "explain":
          return t("reader.selection.explain", "解释");
        case "translate":
          return t("reader.selection.translate", "翻译");
        case "summarize":
          return t("reader.selection.summarize", "概括");
      }
    },
    prompt: (id: BuiltinSelectionActionId) => {
      switch (id) {
        case "ask":
          return "";
        case "explain":
          return t("ai.action.explain", "请解释选中的这段内容。");
        case "translate":
          return t("ai.action.translate", "请把选中的这段内容翻译成简体中文。");
        case "summarize":
          return t("ai.action.summarize", "请概括选中的这段内容。");
      }
    },
  };
}

/** 划词指令列表（读出的原始 DTO）；阅读器挂载时即开始取，工具栏弹出时不用等。 */
export function useSelectionActionsQuery() {
  return useQuery({
    queryKey: qk.selectionActions,
    queryFn: () => window.api.selectionActions.list(),
    staleTime: Infinity,
  });
}

/**
 * 解析好文字 / 图标 / 实际提示语的指令列表（含隐藏的；按列表顺序）。
 * 还没读到（或读取失败）时先按出厂列表显示，工具栏不至于缺了 AI 指令。
 */
export function useSelectionActionViews() {
  const { t } = useTranslation();
  const query = useSelectionActionsQuery();
  const defaults = builtinSelectionDefaults(t);
  return (query.data ?? FACTORY_SELECTION_ACTIONS).map((dto) =>
    resolveSelectionAction(dto, defaults),
  );
}
