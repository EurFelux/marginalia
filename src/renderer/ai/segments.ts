import { isToolUIPart } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡内可渲染的工具 part（static + dynamic）。 */
export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** 气泡内的一段：合并后的文本块，或单个工具步骤行。 */
export type Segment = { kind: "text"; text: string } | { kind: "tool"; part: ToolPart };

/**
 * 把 UIMessage.parts 按出现顺序归并成段序列：连续 text 合并为一段（与既有
 * textOf 全拼接行为一致，避免 markdown 跨段断裂），tool part 独立成段，
 * 其余 part（step-start 等）过滤。空 text part（流式起点）跳过。
 */
export function segments(parts: ChatUIMessage["parts"]): Segment[] {
  const out: Segment[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text === "") continue;
      // 累积仅发生在本次调用新建的对象上；调用方不得跨调用缓存返回的 Segment。
      const last = out.at(-1);
      if (last?.kind === "text") last.text += p.text;
      else out.push({ kind: "text", text: p.text });
    } else if (isToolUIPart(p)) {
      out.push({ kind: "tool", part: p });
    }
  }
  return out;
}
