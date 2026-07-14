import { generateText, isStepCount } from "ai";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { providerCallOptions } from "@main/ai/model-factory";
import { createLogger } from "@main/logger";
import { createReadingReportTools } from "@main/reading-report/tools";

const log = createLogger("report");

export const READING_REPORT_SYSTEM = `You write an editable Markdown completion report in the reader's first person. Focus on questions, judgments, changes, connections, and what the reader wants to retain. Ground every claim about the reader in the reader traces available through tools; omit unsupported sections instead of inventing completeness. Do not turn the report into a book summary. You may compare a previous reading report only when you clearly label it as a cross-reading change rather than evidence from this reading.`;

export interface RunReadingReportAgentInput {
  resolved: Extract<ResolvedModel, { ok: true }>;
  tools: ReturnType<typeof createReadingReportTools>;
  bookTitle: string | null;
  startedAt: number;
  completedAt: number;
  activeSeconds: number;
}

export async function runReadingReportAgent(input: RunReadingReportAgentInput): Promise<string> {
  const result = await generateText({
    model: input.resolved.model,
    reasoning: input.resolved.reasoningEffort,
    instructions: READING_REPORT_SYSTEM,
    prompt: `Write the completion report for ${input.bookTitle ?? "this book"}. This reading ran from ${input.startedAt} to ${input.completedAt} and has ${input.activeSeconds} active reading seconds. Inspect reader traces before writing.`,
    tools: input.tools,
    providerOptions: providerCallOptions(input.resolved.providerType),
    stopWhen: isStepCount(10),
    maxOutputTokens: 4096,
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
