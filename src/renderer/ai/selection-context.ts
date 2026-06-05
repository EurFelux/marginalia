// src/renderer/ai/selection-context.ts
import type { Chip } from "@shared/chat";

export interface SelectionContext {
  selection: Chip | null;
  paragraph: Chip | null;
  tokenTotal: number;
}

/** draft 中选区上下文（selection/paragraph chips）的聚合视图（spec §4 合并 pill）；两者皆无 → null。 */
export function selectionContextOf(chips: Chip[]): SelectionContext | null {
  const selection = chips.find((c) => c.id === "selection") ?? null;
  const paragraph = chips.find((c) => c.id === "paragraph") ?? null;
  if (!selection && !paragraph) return null;
  return {
    selection,
    paragraph,
    tokenTotal: (selection?.tokenCount ?? 0) + (paragraph?.tokenCount ?? 0),
  };
}

/** 整体移除选区上下文（spec §4：一次反悔动作，发送前可撤）。 */
export function withoutSelectionContext(chips: Chip[]): Chip[] {
  return chips.filter((c) => c.id !== "selection" && c.id !== "paragraph");
}
