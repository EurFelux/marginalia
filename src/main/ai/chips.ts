// src/main/ai/chips.ts
import { estimateTokens } from "@shared/tokens";
import type { BuildChipsInput, Chip } from "@shared/chat";
import type { MessageMetadata } from "@shared/types";

/** 由 renderer 提取的原始文本构造 selection / paragraph chip（构建为 on：随消息发送、UI 可整体删除；"required" 仅历史水合产出）。 */
export function buildChips(input: BuildChipsInput): Chip[] {
  const chips: Chip[] = [];

  const selection = input.selection.trim();
  chips.push({
    id: "selection",
    labelKey: "chip.selection",
    content: selection,
    tokenCount: estimateTokens(selection),
    state: "on",
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
      state: "on",
    });
  }

  return chips;
}

/** 段落去重（设计文档 §6）：段落内容与本会话上一次插入的相同则省略该段落 chip。 */
export function dedupeParagraph(chips: Chip[], previousParagraph: string | null): Chip[] {
  if (previousParagraph == null) return chips;
  return chips.filter((c) => !(c.id === "paragraph" && c.content === previousParagraph));
}

/** 把 live chip 投影为持久化快照（落入 UIMessage.metadata.contextChips）。 */
export function toContextChips(chips: Chip[]): NonNullable<MessageMetadata["contextChips"]> {
  return chips.map((c) => ({ id: c.id, content: c.content, tokenCount: c.tokenCount }));
}
