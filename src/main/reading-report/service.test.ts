import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { createDb, runMigrations } from "@main/db/client";
import { annotations, books, memories } from "@main/db/schema";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import {
  completeReading,
  saveReadingReport,
  startReading,
} from "@main/reading-sessions/repository";
import { ReadingReportRuntime } from "@main/reading-report/runtime";
import { setPreference } from "@main/preferences/repository";
import {
  cancelReadingReportGeneration,
  getReadingSessionDetail,
  saveUserReadingReport,
  startReadingReportGeneration,
  type ReadingReportServiceDeps,
} from "@main/reading-report/service";
import type { RunReadingReportAgentInput } from "@main/reading-report/agent";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@main/logger", () => ({
  createLogger: () => ({ warn, debug: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const instant = (value: string) => Temporal.Instant.from(value);
const toolOptions = { toolCallId: "report-memory", messages: [] } as never;
const memoryInput = {
  slug: "durable-insight",
  title: "Durable insight",
  description: "A lasting insight from the reading.",
  body: "A durable insight.",
};

async function executeAgentTool(
  input: RunReadingReportAgentInput,
  name: string,
  toolInput: unknown,
) {
  const candidate = (input.tools as ToolSet)[name];
  if (!candidate?.execute) throw new Error(`${name} tool missing`);
  return candidate.execute(toolInput as never, toolOptions);
}

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
    now: () => instant("2026-07-03T00:00:00Z"),
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

  it("cancels initial generation without accepting a late result", async () => {
    warn.mockClear();
    const { deps, session, task, drain } = setup();
    let signal: AbortSignal | undefined;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn((input) => {
      signal = input.abortSignal;
      return task.promise;
    });

    startReadingReportGeneration(deps, session.id);
    expect(cancelReadingReportGeneration(deps, session.id)).toEqual({ outcome: "canceled" });
    expect(signal?.aborted).toBe(true);
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "empty" });
    expect(cancelReadingReportGeneration(deps, session.id)).toEqual({ outcome: "idle" });

    task.resolve("# Late result");
    await drain();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({ status: "empty" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("cancels regeneration while preserving the old report", async () => {
    warn.mockClear();
    const { deps, session, task, drain } = setup({ report: "# Old" });
    let signal: AbortSignal | undefined;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn((input) => {
      signal = input.abortSignal;
      return task.promise;
    });

    startReadingReportGeneration(deps, session.id);
    expect(cancelReadingReportGeneration(deps, session.id)).toEqual({ outcome: "canceled" });
    expect(signal?.aborted).toBe(true);
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Old",
    });

    task.resolve("# Late result");
    await drain();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Old",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("discards staged memory when cancellation races with completion", async () => {
    const { deps, session, drain } = setup({ report: "# Old" });
    const staged = deferred<void>();
    const finish = deferred<string>();
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      await executeAgentTool(input, "saveMemory", memoryInput);
      staged.resolve();
      return finish.promise;
    });

    startReadingReportGeneration(deps, session.id);
    await staged.promise;
    cancelReadingReportGeneration(deps, session.id);
    finish.resolve("# Late result");
    await drain();

    expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Old",
    });
  });

  it("rebuilds assistant identity and reader instructions for every generation", async () => {
    const { deps, session, drain } = setup();
    const prompts: string[] = [];
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      prompts.push(input.instructions);
      return prompts.length === 1 ? "# First" : "# Second";
    });

    startReadingReportGeneration(deps, session.id);
    await drain();
    expect(prompts[0]).toContain("Your name is Lia");

    setPreference(deps.db, "soul", { name: "Mia", persona: "New voice." });
    setPreference(deps.db, "instructions", "Use bullets.");
    startReadingReportGeneration(deps, session.id);
    await drain();

    expect(prompts[1]).toContain("Your name is Mia. New voice.");
    expect(prompts[1]).toContain("Use bullets.");
  });

  it("commits the generated report and staged memory together", async () => {
    const { deps, session, drain } = setup();
    let memoryToolAvailable = false;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      memoryToolAvailable = "saveMemory" in input.tools;
      if (memoryToolAvailable) await executeAgentTool(input, "saveMemory", memoryInput);
      return "# Report";
    });

    startReadingReportGeneration(deps, session.id);
    await drain();

    expect(memoryToolAvailable).toBe(true);
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Report",
    });
    expect(getMemoryBySlug(deps.db, "durable-insight")?.body).toBe("A durable insight.");
  });

  it("discards staged memory when report generation fails", async () => {
    const { deps, session, drain } = setup();
    let memoryToolAvailable = false;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      memoryToolAvailable = "saveMemory" in input.tools;
      if (memoryToolAvailable) await executeAgentTool(input, "saveMemory", memoryInput);
      throw new Error("model failed");
    });

    startReadingReportGeneration(deps, session.id);
    await drain();

    expect(memoryToolAvailable).toBe(true);
    expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
    expect(getReadingSessionDetail(deps, session.id).report.status).toBe("generation-failed");
  });

  it("discards staged memory from a generation invalidated by a manual save", async () => {
    const { deps, session, drain } = setup();
    const staged = deferred<void>();
    const finish = deferred<string>();
    let memoryToolAvailable = false;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      memoryToolAvailable = "saveMemory" in input.tools;
      if (memoryToolAvailable) await executeAgentTool(input, "saveMemory", memoryInput);
      staged.resolve();
      return finish.promise;
    });

    startReadingReportGeneration(deps, session.id);
    await staged.promise;
    saveUserReadingReport(deps, session.id, "# Manual");
    finish.resolve("# Generated");
    await drain();

    expect(memoryToolAvailable).toBe(true);
    expect(getMemoryBySlug(deps.db, "durable-insight")).toBeNull();
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "ready",
      content: "# Manual",
    });
  });

  it("rolls back the report when an optimistic memory update conflicts", async () => {
    const { deps, session, drain } = setup({ report: "# Old" });
    const existing = createMemory(deps.db, memoryInput);
    const staged = deferred<void>();
    const finish = deferred<string>();
    let memoryToolAvailable = false;
    deps.resolveModel = () => ({ ok: true, model: {} as never, modelId: "summary" });
    deps.runAgent = vi.fn(async (input) => {
      memoryToolAvailable = "updateMemory" in input.tools;
      if (memoryToolAvailable) {
        await executeAgentTool(input, "updateMemory", {
          slug: existing.slug,
          body: "Report update.",
        });
      }
      staged.resolve();
      return finish.promise;
    });

    startReadingReportGeneration(deps, session.id);
    await staged.promise;
    deps.db
      .update(memories)
      .set({ body: "External update.", updatedAt: existing.updatedAt + 1 })
      .where(eq(memories.id, existing.id))
      .run();
    finish.resolve("# Generated");
    await drain();

    expect(memoryToolAvailable).toBe(true);
    expect(getReadingSessionDetail(deps, session.id).report).toEqual({
      status: "regeneration-failed",
      content: "# Old",
    });
    expect(getMemoryBySlug(deps.db, "durable-insight")?.body).toBe("External update.");
  });
});
