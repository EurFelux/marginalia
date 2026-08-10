import { generateText, isStepCount, type ToolSet } from "ai";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { providerCallOptions } from "@main/ai/model-factory";
import { createLogger } from "@main/logger";

const log = createLogger("report");

export interface RunReadingReportAgentInput {
  resolved: Extract<ResolvedModel, { ok: true }>;
  tools: ToolSet;
  instructions: string;
  bookTitle: string | null;
  startedAt: number;
  completedAt: number;
  activeSeconds: number;
  abortSignal: AbortSignal;
}

export async function runReadingReportAgent(input: RunReadingReportAgentInput): Promise<string> {
  const result = await generateText({
    model: input.resolved.model,
    reasoning: input.resolved.reasoningEffort,
    instructions: input.instructions,
    prompt: `Write the completion report for ${input.bookTitle ?? "this book"}. This reading ran from ${input.startedAt} to ${input.completedAt} and has ${input.activeSeconds} active reading seconds. Inspect reader traces before writing.`,
    tools: input.tools,
    providerOptions: providerCallOptions(input.resolved.providerType),
    abortSignal: input.abortSignal,
    stopWhen: isStepCount(10),
    // 刻意不设 maxOutputTokens（对齐 stream-assistant，走 provider 默认）：推理模型的思考 token 与正文
    // 共享该预算，而写报告那步的上下文最大（前若干步的全部工具结果），思考会把小额度吃光、正文一字不出
    // ——表现为 finishReason=length + text 为空，然后被下面的空文本检查报成误导性的 "empty text"。
    maxRetries: 1,
    onStepFinish: ({ finishReason, toolCalls, text }) => {
      log.debug(
        `step finished (finishReason=${finishReason}, toolCalls=${toolCalls.length}, textChars=${text.length})`,
      );
    },
  });
  const text = result.text.trim();
  if (!text) throw new Error("reading report agent returned empty text");
  return text;
}
