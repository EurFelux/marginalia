import type { ReadingReportProgressStep, ReadingReportState } from "@shared/reading-sessions";

export interface ReportViewModel {
  content: string | null;
  busy: boolean;
  canGenerate: boolean;
  canEdit: boolean;
  canCancel: boolean;
  error: "generation-failed" | "regeneration-failed" | null;
  /** 本次生成的工具活动时间线；非生成/非失败态为空。 */
  progress: readonly ReadingReportProgressStep[];
  /** 生成开始时刻（epoch ms），仅生成中非 null —— 渲染层据此自行计时。 */
  startedAt: number | null;
}

export function reportViewModel(state: ReadingReportState): ReportViewModel {
  switch (state.status) {
    case "empty":
      return {
        content: null,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: null,
        progress: [],
        startedAt: null,
      };
    case "generating":
      return {
        content: null,
        busy: true,
        canGenerate: false,
        canEdit: false,
        canCancel: true,
        error: null,
        progress: state.progress,
        startedAt: state.startedAt,
      };
    case "generation-failed":
      return {
        content: null,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: "generation-failed",
        progress: state.progress,
        startedAt: null,
      };
    case "ready":
      return {
        content: state.content,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: null,
        progress: [],
        startedAt: null,
      };
    case "regenerating":
      return {
        content: state.content,
        busy: true,
        canGenerate: false,
        canEdit: false,
        canCancel: true,
        error: null,
        progress: state.progress,
        startedAt: state.startedAt,
      };
    case "regeneration-failed":
      return {
        content: state.content,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: "regeneration-failed",
        progress: state.progress,
        startedAt: null,
      };
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected report state: ${JSON.stringify(value)}`);
}
