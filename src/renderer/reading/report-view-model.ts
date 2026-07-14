import type { ReadingReportState } from "@shared/reading-sessions";

export interface ReportViewModel {
  content: string | null;
  busy: boolean;
  canGenerate: boolean;
  canEdit: boolean;
  error: string | null;
}

export function reportViewModel(state: ReadingReportState): ReportViewModel {
  switch (state.status) {
    case "empty":
      return { content: null, busy: false, canGenerate: true, canEdit: true, error: null };
    case "generating":
      return { content: null, busy: true, canGenerate: false, canEdit: false, error: null };
    case "generation-failed":
      return { content: null, busy: false, canGenerate: true, canEdit: true, error: state.reason };
    case "ready":
      return { content: state.content, busy: false, canGenerate: true, canEdit: true, error: null };
    case "regenerating":
      return {
        content: state.content,
        busy: true,
        canGenerate: false,
        canEdit: false,
        error: null,
      };
    case "regeneration-failed":
      return {
        content: state.content,
        busy: false,
        canGenerate: true,
        canEdit: true,
        error: state.reason,
      };
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected report state: ${JSON.stringify(value)}`);
}
