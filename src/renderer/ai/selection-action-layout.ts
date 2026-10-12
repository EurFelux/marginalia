import {
  SELECTION_ACTION_INLINE_ICONS,
  SELECTION_ACTION_INLINE_LABELED,
} from "@shared/selection-actions";

/** 工具栏平铺几个：显示文字时 4 个，只显示图标时 8 个（spec 2026-10-12 §3.4）。 */
export function inlineCountFor(showLabels: boolean): number {
  return showLabels ? SELECTION_ACTION_INLINE_LABELED : SELECTION_ACTION_INLINE_ICONS;
}

/** 工具栏上的划分：只看显示中的指令，前 inlineCount 个平铺，其余收进「更多」。 */
export function splitToolbarActions<T extends { enabled: boolean }>(
  actions: readonly T[],
  inlineCount: number,
): { inline: T[]; overflow: T[] } {
  const shown = actions.filter((a) => a.enabled);
  return { inline: shown.slice(0, inlineCount), overflow: shown.slice(inlineCount) };
}

/**
 * 设置页「以下收进『更多』」分隔线画在哪一项之后（完整列表的下标）：第 inlineCount 个显示中的指令之后，
 * 且其后还有显示中的指令才画；否则 -1。隐藏的指令不计数。
 */
export function moreDividerAfter<T extends { enabled: boolean }>(
  actions: readonly T[],
  inlineCount: number,
): number {
  let shown = 0;
  for (let i = 0; i < actions.length; i++) {
    if (!actions[i].enabled) continue;
    shown++;
    if (shown === inlineCount) return actions.slice(i + 1).some((a) => a.enabled) ? i : -1;
  }
  return -1;
}
