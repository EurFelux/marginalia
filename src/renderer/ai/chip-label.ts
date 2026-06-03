import type { Chip } from "@shared/chat";
import i18n from "@renderer/i18n";

/** chip 的本地化显示名（调用时求值，跟随 UI 语言）。 */
export const chipLabel = (chip: Chip): string => {
  switch (chip.labelKey) {
    case "chip.selection":
      return i18n.t("ai.chip.selection", "选区");
    case "chip.paragraph":
      return i18n.t("ai.chip.paragraph", "段落上下文");
    default:
      return chip.labelKey;
  }
};
