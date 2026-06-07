// src/renderer/ai/tool-step-label.ts
import { getToolName } from "ai";
import type { TFunction } from "i18next";
import type { ChapterRefDto } from "@shared/library";
import type { ToolPart } from "@renderer/ai/segments";

/**
 * 工具软失败 result 形状：主进程 runTool 把 execute 抛错转成 { error } 正常 result
 * 喂回模型自我纠正（见 src/main/ai/tools.ts），故 state === "output-error" 几乎不触发，
 * 失败判定必须同时识别本形状。
 */
export function isErrorShape(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output;
}

export type ToolStepStatus = "loading" | "done" | "failed";

/** 步骤行三态：failed 两条腿（硬 error state + 软 { error } result），其余 output-available 为 done。 */
export function toolStepStatus(part: ToolPart): ToolStepStatus {
  if (part.state === "output-error") return "failed";
  if (part.state === "output-available") return isErrorShape(part.output) ? "failed" : "done";
  return "loading";
}

/**
 * 宽容匹配章节引用（与主进程 resolveChapterRef 对齐）：id 精确 → href → 唯一标题
 * （大小写不敏感）。模型给 input 的是原始引用，主进程的规范化结果不回写 input，
 * 渲染层须自行匹配；匹配不到返回 null（调用方回退通用标题）。
 */
function chapterTitle(chapters: ChapterRefDto[], ref: string): string | null {
  const byId = chapters.find((c) => c.id === ref);
  if (byId) return byId.title;
  const byHref = chapters.find((c) => c.href === ref);
  if (byHref) return byHref.title;
  const wanted = ref.trim().toLowerCase();
  const byTitle = chapters.filter((c) => (c.title ?? "").trim().toLowerCase() === wanted);
  return byTitle.length === 1 ? byTitle[0]!.title : null;
}

function inputChapterTitle(
  chapters: ChapterRefDto[],
  input: Record<string, unknown> | undefined,
): string | null {
  return typeof input?.chapterId === "string" ? chapterTitle(chapters, input.chapterId) : null;
}

/**
 * 步骤行人话标题：带参数（页码/章节名）让用户一眼看懂 AI 在干什么；
 * 参数缺失（流式 partial input）或解析不到时回退工具级通用标题，绝不抛错。
 * t 由组件层注入——本模块不得 import @renderer/i18n（无头测试会崩，见其头注释）。
 */
export function toolStepLabel(part: ToolPart, chapters: ChapterRefDto[], t: TFunction): string {
  const name = getToolName(part);
  const input = part.input as Record<string, unknown> | undefined;
  switch (name) {
    case "readPage": {
      const page = input?.page;
      return typeof page === "number"
        ? t("ai.toolStep.readPage", "读取第 {{page}} 页", { page })
        : t("ai.toolStep.readPageFallback", "读取页面");
    }
    case "readChapterText": {
      const title = inputChapterTitle(chapters, input);
      return title !== null
        ? t("ai.toolStep.readChapterText", "读取〈{{title}}〉", { title })
        : t("ai.toolStep.readChapterTextFallback", "读取章节文本");
    }
    case "getChapterSummary": {
      const title = inputChapterTitle(chapters, input);
      return title !== null
        ? t("ai.toolStep.getChapterSummary", "读取〈{{title}}〉摘要", { title })
        : t("ai.toolStep.getChapterSummaryFallback", "读取章节摘要");
    }
    case "getToc":
      return t("ai.toolStep.getToc", "读取目录");
    default:
      return name;
  }
}
