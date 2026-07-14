import type { ReadingReportState } from "@shared/reading-sessions";

export type GenerationKind = "initial" | "regeneration";
export type Failure = { kind: GenerationKind; reason: string };

const hasReport = (report: string | null): report is string => Boolean(report?.trim());

/** Process-local report generation state. Deliberately instance-owned: app restart derives only from SQLite. */
export class ReadingReportRuntime {
  readonly inFlight = new Map<string, GenerationKind>();
  readonly failures = new Map<string, Failure>();
  readonly #generations = new Map<string, number>();

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

  claim(sessionId: string, kind: GenerationKind): number | undefined {
    if (this.inFlight.has(sessionId)) return undefined;
    const generation = (this.#generations.get(sessionId) ?? 0) + 1;
    this.#generations.set(sessionId, generation);
    this.failures.delete(sessionId);
    this.inFlight.set(sessionId, kind);
    return generation;
  }

  isCurrent(sessionId: string, generation: number): boolean {
    return this.inFlight.has(sessionId) && this.#generations.get(sessionId) === generation;
  }

  fail(sessionId: string, failure: Failure, generation?: number): boolean {
    if (generation != null && !this.isCurrent(sessionId, generation)) return false;
    this.inFlight.delete(sessionId);
    this.failures.set(sessionId, failure);
    return true;
  }

  succeed(sessionId: string, generation?: number): boolean {
    if (generation != null && !this.isCurrent(sessionId, generation)) return false;
    this.inFlight.delete(sessionId);
    this.failures.delete(sessionId);
    return true;
  }

  clearFailure(sessionId: string): void {
    this.failures.delete(sessionId);
  }

  /** A user-authored save supersedes every previously claimed background generation. */
  invalidate(sessionId: string): void {
    this.#generations.set(sessionId, (this.#generations.get(sessionId) ?? 0) + 1);
    this.inFlight.delete(sessionId);
    this.failures.delete(sessionId);
  }
}
