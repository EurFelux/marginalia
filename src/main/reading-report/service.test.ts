import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { annotations, books } from "@main/db/schema";
import {
  completeReading,
  saveReadingReport,
  startReading,
} from "@main/reading-sessions/repository";
import { ReadingReportRuntime } from "@main/reading-report/runtime";
import {
  getReadingSessionDetail,
  saveUserReadingReport,
  startReadingReportGeneration,
  type ReadingReportServiceDeps,
} from "@main/reading-report/service";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@main/logger", () => ({
  createLogger: () => ({ warn, debug: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const instant = (value: string) => Temporal.Instant.from(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: { report?: string; evidence?: boolean } = {}) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book", title: "The Book" }).run();
  const session = startReading(db, {
    bookId: "book",
    mode: "continue",
    startedAt: instant("2026-07-01T00:00:00Z"),
  });
  completeReading(db, "book", instant("2026-07-02T00:00:00Z"));
  if (options.report) saveReadingReport(db, session.id, options.report);
  if (options.evidence !== false) {
    db.insert(annotations)
      .values({
        bookId: "book",
        style: "yellow",
        selectedText: "a trace",
        locatorRange: "loc",
        createdAt: instant("2026-07-01T12:00:00Z").epochMilliseconds,
        updatedAt: instant("2026-07-01T12:00:00Z").epochMilliseconds,
      })
      .run();
  }
  const task = deferred<string>();
  const runAgent = vi.fn(() => task.promise);
  const background: Promise<unknown>[] = [];
  const deps: ReadingReportServiceDeps = {
    db,
    loadBytes: async () => new Uint8Array(),
    resolveModel: vi.fn(() => ({ ok: false as const, reason: "missing model" })),
    runBackground: async (fn) => {
      const work = fn();
      background.push(work.catch(() => undefined));
      return work;
    },
    runAgent,
    runtime: new ReadingReportRuntime(),
  };
  return { deps, session, task, runAgent, drain: async () => Promise.all(background) };
}

describe("reading report service", () => {
  it("derives empty, generating, and ready around a background generation", async () => {
    const { deps, session, task, drain } = setup();
    const resolved = { ok: true as const, model: {} as never, modelId: "summary" };
    deps.resolveModel = () => resolved;

    expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "empty" });
    expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "accepted" });
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "generating" });
    task.resolve(" # What stayed with me ");
    await drain();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# What stayed with me",
    });
  });

  it("keeps the old report through regeneration and records failures by kind", async () => {
    const { deps, session, task, drain } = setup({ report: "# Old" });
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "accepted" });
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "regenerating",
      content: "# Old",
    });
    task.reject(new Error("network down"));
    await drain();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "regeneration-failed",
      content: "# Old",
    });
  });

  it("deduplicates starts, returns insufficient evidence without resolving a model, and resets state on a fresh runtime", () => {
    const noEvidence = setup({ evidence: false });
    expect(startReadingReportGeneration(noEvidence.deps, noEvidence.session.id)).toEqual({
      outcome: "insufficient-evidence",
    });
    expect(noEvidence.deps.resolveModel).not.toHaveBeenCalled();
    expect(noEvidence.runAgent).not.toHaveBeenCalled();

    const { deps, session } = setup();
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "accepted" });
    expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "accepted" });
    expect(
      getReadingSessionDetail({ db: deps.db, runtime: new ReadingReportRuntime() }, session.id)
        .report,
    ).toEqual({ status: "empty" });
  });

  it("clears a prior failure when evidence is unavailable", () => {
    const { deps, session } = setup({ report: "# Existing", evidence: false });
    deps.runtime.fail(session.id, { kind: "regeneration" });

    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "regeneration-failed",
      content: "# Existing",
    });
    expect(startReadingReportGeneration(deps, session.id)).toEqual({
      outcome: "insufficient-evidence",
    });
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Existing",
    });
  });

  it("records missing-model failures without exposing their internal reason, and a user save clears it", () => {
    warn.mockClear();
    const { deps, session } = setup();
    expect(startReadingReportGeneration(deps, session.id)).toEqual({ outcome: "unavailable" });
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "generation-failed",
    });
    expect(saveUserReadingReport(deps, session.id, " # Written ").report).toEqual({
      status: "ready",
      content: "# Written",
    });
    expect(warn).toHaveBeenCalledWith(
      "summary model unavailable",
      expect.objectContaining({ message: "missing model" }),
    );
  });

  it("keeps a manual save when an older generation completes", async () => {
    const { deps, session, task, drain } = setup();
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });

    startReadingReportGeneration(deps, session.id);
    expect(saveUserReadingReport(deps, session.id, "# Manual").report).toEqual({
      status: "ready",
      content: "# Manual",
    });
    task.resolve("# Generated");
    await drain();

    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Manual",
    });
    expect(deps.runtime.inFlight.has(session.id)).toBe(false);
  });
});
