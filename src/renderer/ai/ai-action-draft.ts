import type { SelectionActionView } from "@shared/selection-actions";

/**
 * 点了一个划词指令后怎么处置输入框（纯决策，无 i18n 依赖，故可无头单测；spec 2026-10-12 §3.5）：
 * - `keepDraft`：没有提示语（没写提示语的「询问」）→ 只附上选区，**保留**读者已输入的文字；
 * - `fill`：有提示语、不直接发送 → 用提示语**覆盖**草稿，等读者补充或按回车；
 * - `send`：有提示语、直接发送 → 立即发出，不动草稿文字。AI 正在回复时不可用（见 isBlockedWhileReplying）。
 */
export type SelectionActionPlan = "keepDraft" | "fill" | "send";

/** AI 正在回复时，开着直接发送的指令不可用：发不出去，退回填入又会盖掉草稿（spec 2026-10-12 §3.5）。 */
export function isBlockedWhileReplying(
  action: Pick<SelectionActionView, "autoSend">,
  replying: boolean,
): boolean {
  return replying && action.autoSend;
}

export function planSelectionAction(
  action: Pick<SelectionActionView, "prompt" | "autoSend">,
): SelectionActionPlan {
  if (action.prompt.trim() === "") return "keepDraft";
  return action.autoSend ? "send" : "fill";
}
