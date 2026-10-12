// AI 回复的过程折叠投影（spec 2026-10-12-assistant-process-fold-design §3）：
// 段序列 → 折叠区 / 待批块 / 常显区，标题行是否为进行中形态，以及用时的展示分解。纯函数，无头可测。
import { getToolName } from "ai";
import type { Segment, ToolPart } from "@renderer/ai/segments";
import { toolStepStatus } from "@renderer/ai/tool-step-label";

/**
 * 记忆类工具不切断回答（§3.1）：AI 常在写完回答后才存记忆、再补一句「记下了」，
 * 若以它们为界，真正的回答会被收起。
 */
const MEMORY_TOOLS = new Set([
  "readMemory",
  "saveMemory",
  "updateMemory",
  "deleteMemory",
  "updateSoul",
]);

export interface AssistantLayout {
  /** 收进折叠区的段（原顺序）：最后一次过程类工具调用及其之前的一切。 */
  process: Segment[];
  /** 等待批准的 bash：不收进折叠区，紧接其下显示（§3.5）。 */
  awaiting: ToolPart[];
  /** 常显区：最后一次过程类工具调用之后的段——回答文本与夹在其中的记忆类步骤。 */
  answer: Segment[];
}

/** §3.1：以最后一次过程类工具调用为界切分；待批块从折叠区里单独拎出。 */
export function assistantLayout(
  segs: Segment[],
  isAwaiting: (part: ToolPart) => boolean,
): AssistantLayout {
  const cut = segs.findLastIndex(
    (s) => s.kind === "tool" && !MEMORY_TOOLS.has(getToolName(s.part)),
  );
  const process: Segment[] = [];
  const awaiting: ToolPart[] = [];
  for (const s of segs.slice(0, cut + 1)) {
    if (s.kind === "tool" && isAwaiting(s.part)) awaiting.push(s.part);
    else process.push(s);
  }
  return { process, awaiting, answer: segs.slice(cut + 1) };
}

/** 折叠区里没有工具调用（只剩待批块前的几句话）时不出现折叠区，文本照常显示（§3.5）。 */
export function hasToolCall(process: Segment[]): boolean {
  return process.some((s) => s.kind === "tool");
}

/** 常显区的文本，复制按钮用（§3.7）：多段（中间隔着记忆类步骤）以空行连接。 */
export function answerText(answer: Segment[]): string {
  return answer.flatMap((s) => (s.kind === "text" ? [s.text] : [])).join("\n\n");
}

/** 收起时的进行中形态（§3.2）：回复在生成、且最后一个工具调用还没出结果，返回这一步。 */
export function runningStep(process: Segment[], streaming: boolean): ToolPart | null {
  const last = process.at(-1);
  if (!streaming || last?.kind !== "tool") return null;
  return toolStepStatus(last.part, true) === "loading" ? last.part : null;
}

/** 本轮用时的展示分解（整数运算）：四舍五入到秒，至少 1 秒；满一分钟拆出分。 */
export function turnDurationParts(ms: number): { min: number; sec: number } {
  const total = Math.max(1, Math.round(ms / 1000));
  return { min: Math.floor(total / 60), sec: total % 60 };
}
