// src/main/reading-report/submission.ts —— 报告由 agent 调 submitReport 自己落库，而不是我们取它的输出去存。
// 曾取 generateText 的 result.text 当报告：那只是最后一步的文字，模型在写完正文后多说的一句
// 收尾话就会顶替整份报告入库（#119）。
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createLogger } from "@main/logger";

const log = createLogger("report");

export interface ReadingReportSubmissionDeps {
  /** 本次生成的中止信号：已取消或被手动保存顶替的生成不得落库。 */
  signal: AbortSignal;
  /** 把报告（连同暂存的记忆修改）写进 DB；抛错即未写入。 */
  commit: (markdown: string) => void;
}

export interface ReadingReportSubmission {
  tools: ToolSet;
  submitted: () => boolean;
}

/**
 * 只导出工厂、不导出现成的 tool：唯一的 commit 由报告 service 按一次生成现绑，
 * 故 submitReport 只可能出现在阅读报告主 agent 的工具集里（spec 2026-10-03 §3.8）。
 */
export function createReadingReportSubmission({
  signal,
  commit,
}: ReadingReportSubmissionDeps): ReadingReportSubmission {
  let submitted = false;
  return {
    submitted: () => submitted,
    tools: {
      submitReport: tool({
        description:
          "Save the finished Markdown report for the reader. Only the submitted Markdown reaches the reader; call it once, as your final action.",
        inputSchema: z.object({ markdown: z.string() }),
        execute: async ({ markdown }) => {
          if (submitted) {
            return { saved: false as const, error: "the report has already been submitted" };
          }
          if (!markdown.trim()) {
            return {
              saved: false as const,
              error: "the report is empty; submit the complete Markdown report",
            };
          }
          // 取消与被顶替是预期的竞态：直接抛出，不回给 agent 也不记 warn，循环随中止结束。
          signal.throwIfAborted();
          try {
            commit(markdown);
          } catch (err) {
            log.warn("report submission failed", err);
            const reason = err instanceof Error ? err.message : String(err);
            return {
              saved: false as const,
              error: `saving failed and retrying will not help: ${reason}`,
            };
          }
          submitted = true;
          return {
            saved: true as const,
            hint: "The report is saved and shown to the reader. Your task is complete.",
          };
        },
      }),
    },
  };
}
