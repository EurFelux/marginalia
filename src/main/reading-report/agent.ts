import { generateText, isStepCount, type ToolSet } from "ai";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { providerCallOptions } from "@main/ai/model-factory";
import { createLogger } from "@main/logger";

const log = createLogger("report");

/**
 * 工具步上限。刻意保留而非取消：取消后模型卡在翻页循环里就没有兜底了。
 * 需容纳「列清单 + 外派若干 subagent + 回读几段原文 + 写正文」，10 步曾在写正文前就耗尽。
 */
export const REPORT_AGENT_MAX_STEPS = 40;

export interface RunReadingReportAgentInput {
  resolved: Extract<ResolvedModel, { ok: true }>;
  tools: ToolSet;
  instructions: string;
  bookTitle: string | null;
  startedAt: number;
  completedAt: number;
  activeSeconds: number;
  abortSignal: AbortSignal;
  /** submitReport 已成功落库：那一步执行完即结束，不再为一句不展示的收尾话多调一次模型。 */
  isSubmitted: () => boolean;
}

/** 报告经 tools 里的 submitReport 落库；本函数不产出报告文本，是否提交由调用方查验。 */
export async function runReadingReportAgent(input: RunReadingReportAgentInput): Promise<void> {
  await generateText({
    model: input.resolved.model,
    reasoning: input.resolved.reasoningEffort,
    instructions: input.instructions,
    prompt: `Write the completion report for ${input.bookTitle ?? "this book"}. This reading ran from ${input.startedAt} to ${input.completedAt} and has ${input.activeSeconds} active reading seconds. Inspect all reader traces before writing; conversation evidence is paginated. Deliver it with submitReport.`,
    tools: input.tools,
    providerOptions: providerCallOptions(input.resolved.providerType),
    abortSignal: input.abortSignal,
    stopWhen: [isStepCount(REPORT_AGENT_MAX_STEPS), () => input.isSubmitted()],
    // 刻意不设 maxOutputTokens（对齐 stream-assistant，走 provider 默认）：推理模型的思考 token 与正文
    // 共享该预算，而写报告那步的上下文最大（前若干步的全部工具结果），思考会把小额度吃光、正文一字不出
    // ——表现为 finishReason=length 且报告从未提交。
    maxRetries: 1,
    onStepFinish: ({ finishReason, toolCalls, text }) => {
      log.debug(
        `step finished (finishReason=${finishReason}, toolCalls=${toolCalls.length}, textChars=${text.length})`,
      );
    },
  });
}
