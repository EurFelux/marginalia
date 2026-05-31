// src/main/ai/chips.ts
import { estimateTokens } from "@main/ai/tokens";
import type { BuildChipsInput, Chip } from "@shared/chat";

/** 由 renderer 提取的原始文本构造 selection / paragraph chip（不含会话上下文；去重见 dedupeParagraph）。 */
export function buildChips(input: BuildChipsInput): Chip[] {
  const chips: Chip[] = [];

  const selection = input.selection.trim();
  chips.push({
    id: "selection",
    labelKey: "chip.selection",
    content: selection,
    tokenCount: estimateTokens(selection),
    required: true,
    enabled: true,
  });

  const paragraph = [input.paragraphBefore, input.paragraphCurrent, input.paragraphAfter]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join("\n\n");
  if (paragraph) {
    chips.push({
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: paragraph,
      tokenCount: estimateTokens(paragraph),
      required: true,
      enabled: true,
    });
  }

  return chips;
}

/** 段落去重（设计文档 §6）：段落内容与本会话上一次插入的相同则省略该段落 chip。 */
export function dedupeParagraph(chips: Chip[], previousParagraph: string | null): Chip[] {
  if (previousParagraph == null) return chips;
  return chips.filter((c) => !(c.id === "paragraph" && c.content === previousParagraph));
}
