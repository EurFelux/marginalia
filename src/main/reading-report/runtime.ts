import type {
  ReadingReportProgressOutcome,
  ReadingReportProgressStep,
  ReadingReportState,
} from "@shared/reading-sessions";

export type GenerationKind = "initial" | "regeneration";
export type Failure = { kind: GenerationKind };
export interface GenerationClaim {
  generation: number;
  signal: AbortSignal;
}

const hasReport = (report: string | null): report is string => Boolean(report?.trim());

/** 40 步的工具上限 + 余量；防异常循环把内存撑爆。 */
const PROGRESS_LIMIT = 50;

export interface ProgressSink {
  /** 工具开始执行；返回的 id 用于配对 finish。 */
  start(tool: string): string;
  finish(id: string, outcome: ReadingReportProgressOutcome, count: number | null): void;
}

interface ProgressRun {
  startedAt: number;
  steps: ReadingReportProgressStep[];
  nextId: number;
}

/** Process-local report generation state. Deliberately instance-owned: app restart derives only from SQLite. */
export class ReadingReportRuntime {
  readonly inFlight = new Map<string, GenerationKind>();
  readonly failures = new Map<string, Failure>();
  readonly #generations = new Map<string, number>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #progress = new Map<string, ProgressRun>();
  readonly #now: () => number;

  constructor(now: () => number = () => Temporal.Now.instant().epochMilliseconds) {
    this.#now = now;
  }

  state(sessionId: string, storedReport: string | null): ReadingReportState {
    const run = this.#progress.get(sessionId);
    const kind = this.inFlight.get(sessionId);
    if (kind) {
      const live = { startedAt: run?.startedAt ?? this.#now(), progress: run?.steps ?? [] };
      return hasReport(storedReport)
        ? { status: "regenerating", content: storedReport.trim(), ...live }
        : { status: "generating", ...live };
    }
    const failure = this.failures.get(sessionId);
    if (failure) {
      const progress = run?.steps ?? [];
      return hasReport(storedReport)
        ? { status: "regeneration-failed", content: storedReport.trim(), progress }
        : { status: "generation-failed", progress };
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
    this.#progress.set(sessionId, { startedAt: this.#now(), steps: [], nextId: 1 });
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
    this.#progress.delete(sessionId);
    return true;
  }

  /**
   * 绑定到某一次生成的进度出口。generation 不再是当前世代时全部调用变成空操作，
   * 免得被顶掉的旧生成把事件写进新生成的时间线。
   */
  sink(sessionId: string, generation: number): ProgressSink {
    return {
      start: (tool) => {
        const run = this.#progress.get(sessionId);
        if (!run || !this.isCurrent(sessionId, generation)) return "";
        const id = String(run.nextId++);
        run.steps.push({
          id,
          tool,
          startedAt: this.#now(),
          endedAt: null,
          outcome: null,
          count: null,
        });
        if (run.steps.length > PROGRESS_LIMIT) {
          run.steps.splice(0, run.steps.length - PROGRESS_LIMIT);
        }
        return id;
      },
      finish: (id, outcome, count) => {
        const step = this.#progress.get(sessionId)?.steps.find((entry) => entry.id === id);
        if (!step) return;
        step.endedAt = this.#now();
        step.outcome = outcome;
        step.count = count;
      },
    };
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
    this.#progress.delete(sessionId);
    return controller;
  }
}
