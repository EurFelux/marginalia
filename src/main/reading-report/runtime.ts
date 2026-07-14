import type { ReadingReportState } from "@shared/reading-sessions";

export type GenerationKind = "initial" | "regeneration";
export type Failure = { kind: GenerationKind };
export interface GenerationClaim {
  generation: number;
  signal: AbortSignal;
}

const hasReport = (report: string | null): report is string => Boolean(report?.trim());

/** Process-local report generation state. Deliberately instance-owned: app restart derives only from SQLite. */
export class ReadingReportRuntime {
  readonly inFlight = new Map<string, GenerationKind>();
  readonly failures = new Map<string, Failure>();
  readonly #generations = new Map<string, number>();
  readonly #controllers = new Map<string, AbortController>();

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
        ? { status: "regeneration-failed", content: storedReport.trim() }
        : { status: "generation-failed" };
    }
    return hasReport(storedReport)
      ? { status: "ready", content: storedReport.trim() }
      : { status: "empty" };
  }

  claim(sessionId: string, kind: GenerationKind): GenerationClaim | undefined {
    if (this.inFlight.has(sessionId)) return undefined;
    const generation = (this.#generations.get(sessionId) ?? 0) + 1;
    const controller = new AbortController();
    this.#generations.set(sessionId, generation);
    this.#controllers.set(sessionId, controller);
    this.failures.delete(sessionId);
    this.inFlight.set(sessionId, kind);
    return { generation, signal: controller.signal };
  }

  isCurrent(sessionId: string, generation: number): boolean {
    return this.inFlight.has(sessionId) && this.#generations.get(sessionId) === generation;
  }

  fail(sessionId: string, failure: Failure, generation?: number): boolean {
    if (generation != null && !this.isCurrent(sessionId, generation)) return false;
    this.inFlight.delete(sessionId);
    this.#controllers.delete(sessionId);
    this.failures.set(sessionId, failure);
    return true;
  }

  succeed(sessionId: string, generation?: number): boolean {
    if (generation != null && !this.isCurrent(sessionId, generation)) return false;
    this.inFlight.delete(sessionId);
    this.#controllers.delete(sessionId);
    this.failures.delete(sessionId);
    return true;
  }

  clearFailure(sessionId: string): void {
    this.failures.delete(sessionId);
  }

  cancel(sessionId: string): boolean {
    const controller = this.#controllers.get(sessionId);
    if (!controller) return false;
    this.#invalidate(sessionId);
    controller.abort();
    return true;
  }

  /** A user-authored save supersedes every previously claimed background generation. */
  invalidate(sessionId: string): void {
    const controller = this.#invalidate(sessionId);
    controller?.abort();
  }

  #invalidate(sessionId: string): AbortController | undefined {
    const controller = this.#controllers.get(sessionId);
    this.#generations.set(sessionId, (this.#generations.get(sessionId) ?? 0) + 1);
    this.#controllers.delete(sessionId);
    this.inFlight.delete(sessionId);
    this.failures.delete(sessionId);
    return controller;
  }
}
