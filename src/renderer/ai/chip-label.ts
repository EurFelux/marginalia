import type { Chip } from "@shared/chat";

const CHIP_LABEL: Record<string, string> = {
  "chip.selection": "选区",
  "chip.paragraph": "段落上下文",
};

/** chip 的中文显示名（竖切不上 i18n，labelKey → 直写中文）。 */
export const chipLabel = (chip: Chip): string => CHIP_LABEL[chip.labelKey] ?? chip.labelKey;
