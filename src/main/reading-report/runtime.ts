import type { ReadingReportState } from "@shared/reading-sessions";

export type GenerationKind = "initial" | "regeneration";
export type Failure = { kind: GenerationKind; reason: string };

const hasReport = (report: string | null): report is string => Boolean(report?.trim());

/** Process-local report generation state. Deliberately instance-owned: app restart derives only from SQLite. */
export class ReadingReportRuntime {
  readonly inFlight = new Map<string, GenerationKind>();
  readonly failures = new Map<string, Failure>();

  state(sessionId: string, storedReport: string | null): ReadingReportState {
    const kind = this.inFlight.get(sessionId);
    if (kind) {
      return hasReport(storedReport)
        ? { status: "regenerating", content: storedReport.trim() }
        : { status: "generating" };
    }
    const failure = this.failures.get(sessionId);
    if (failure) {
      return hasReport(storedReport)
        ? { status: "regeneration-failed", content: storedReport.trim(), reason: failure.reason }
        : { status: "generation-failed", reason: failure.reason };
    }
    return hasReport(storedReport)
      ? { status: "ready", content: storedReport.trim() }
      : { status: "empty" };
  }

  claim(sessionId: string, kind: GenerationKind): boolean {
    if (this.inFlight.has(sessionId)) return false;
    this.failures.delete(sessionId);
    this.inFlight.set(sessionId, kind);
    return true;
  }

  fail(sessionId: string, failure: Failure): void {
    this.inFlight.delete(sessionId);
    this.failures.set(sessionId, failure);
  }

  succeed(sessionId: string): void {
    this.inFlight.delete(sessionId);
    this.failures.delete(sessionId);
  }

  clearFailure(sessionId: string): void {
    this.failures.delete(sessionId);
  }
}
