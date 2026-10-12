import type { SelectionActionView } from "@shared/selection-actions";

/**
 * 点了一个划词指令后怎么处置输入框（纯决策，无 i18n 依赖，故可无头单测；spec 2026-10-12 §3.5）：
 * - `keepDraft`：没有提示语（没写提示语的「询问」）→ 只附上选区，**保留**读者已输入的文字；
 * - `fill`：有提示语、不直接发送 → 用提示语**覆盖**草稿，等读者补充或按回车；
 * - `send`：有提示语、直接发送 → 立即发出，不动草稿文字。发不出去（AI 正在回复）时由调用方退回 `fill`。
 */
export type SelectionActionPlan = "keepDraft" | "fill" | "send";

export function planSelectionAction(
  action: Pick<SelectionActionView, "prompt" | "autoSend">,
): SelectionActionPlan {
  if (action.prompt.trim() === "") return "keepDraft";
  return action.autoSend ? "send" : "fill";
}
