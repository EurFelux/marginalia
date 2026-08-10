// src/main/reading-report/progress.ts —— 把工具调用变成用户可见的生成进度事件。
import type { ToolSet } from "ai";
import type { ReadingReportProgressOutcome } from "@shared/reading-sessions";
import type { ProgressSink } from "@main/reading-report/runtime";

/** 报告工具的输出统一是分页形状；从中抽出可展示的条目数，抽不到返回 null。 */
export function progressCount(output: unknown): number | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  for (const key of ["items", "messages"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/**
 * 只区分「成功」与「被跳过」。runTool 把异常吞成 { error }、investigateConversation
 * 把拿不到额度/调查失败降级成 busy/failed —— 这些都是既定降级路径，对用户显示为「已跳过」
 * 而非报错，免得让人以为整份报告废了。
 */
export function progressOutcome(output: unknown): ReadingReportProgressOutcome {
  if (typeof output !== "object" || output === null) return "ok";
  const record = output as Record<string, unknown>;
  if (typeof record.error === "string") return "skipped";
  if (record.status === "busy" || record.status === "failed") return "skipped";
  return "ok";
}

type AnyExecute = (input: never, options: never) => unknown;

/**
 * 在每个工具的 execute 入口/出口上报进度。刻意不用 generateText 的 onStepFinish：
 * 那只在步结束后触发，「正在读第 3 个会话」要等读完才显示，恰好错过需要反馈的那段时间。
 */
export function withProgress<T extends ToolSet>(tools: T, sink: ProgressSink): T {
  const entries = Object.entries(tools).map(([name, definition]) => {
    const execute = (definition as { execute?: AnyExecute }).execute;
    if (typeof execute !== "function") return [name, definition] as const;
    const wrapped = async (input: never, options: never) => {
      const id = sink.start(name);
      try {
        const output = await execute(input, options);
        sink.finish(id, progressOutcome(output), progressCount(output));
        return output;
      } catch (err) {
        sink.finish(id, "skipped", null);
        throw err;
      }
    };
    return [name, { ...definition, execute: wrapped }] as const;
  });
  return Object.fromEntries(entries) as T;
}
