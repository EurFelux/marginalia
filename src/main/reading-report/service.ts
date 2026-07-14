import { eq } from "drizzle-orm";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { createLogger } from "@main/logger";
import { supportsImageToolResults } from "@main/ai/model-factory";
import type { LoadBytes } from "@main/ai/tools";
import { hasReaderEvidence } from "@main/reading-report/evidence";
import { runReadingReportAgent } from "@main/reading-report/agent";
import { ReadingReportRuntime, type GenerationKind } from "@main/reading-report/runtime";
import { createReadingReportTools } from "@main/reading-report/tools";
import {
  getReadingSession,
  readingSessionSeconds,
  saveReadingReport,
  toReadingSessionSummary,
} from "@main/reading-sessions/repository";
import type {
  GenerateReadingReportResult,
  ReadingSessionDetailDto,
} from "@shared/reading-sessions";

const log = createLogger("report");
const SAFE_FAILURE_REASON = "Unable to generate reading report";

export interface ReadingReportServiceDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
  runBackground: RunBackground;
  runAgent: typeof runReadingReportAgent;
  runtime: ReadingReportRuntime;
}

function completedSession(db: DB, sessionId: string) {
  const session = getReadingSession(db, sessionId);
  if (!session) throw new Error(`reading session not found: ${sessionId}`);
  if (session.completedAt == null)
    throw new Error("cannot generate a report for an active reading session");
  return session;
}

export function getReadingSessionDetail(
  deps: Pick<ReadingReportServiceDeps, "db" | "runtime">,
  sessionId: string,
): ReadingSessionDetailDto {
  const session = completedSession(deps.db, sessionId);
  return {
    session: toReadingSessionSummary(deps.db, session),
    report: deps.runtime.state(session.id, session.report),
  };
}

export function startReadingReportGeneration(
  deps: ReadingReportServiceDeps,
  sessionId: string,
): GenerateReadingReportResult {
  const session = completedSession(deps.db, sessionId);
  if (deps.runtime.inFlight.has(sessionId)) return { outcome: "accepted" };
  if (!hasReaderEvidence(deps.db, session)) {
    deps.runtime.clearFailure(sessionId);
    return { outcome: "insufficient-evidence" };
  }
  const resolved = deps.resolveModel();
  const kind: GenerationKind = session.report?.trim() ? "regeneration" : "initial";
  if (!resolved.ok) {
    const error = new Error(resolved.reason);
    log.warn("summary model unavailable", error);
    deps.runtime.fail(sessionId, { kind, reason: resolved.reason });
    throw error;
  }
  const generation = deps.runtime.claim(sessionId, kind);
  if (generation == null) return { outcome: "accepted" };
  void deps
    .runBackground(async () => {
      const title =
        deps.db.select({ title: books.title }).from(books).where(eq(books.id, session.bookId)).get()
          ?.title ?? null;
      const tools = createReadingReportTools({
        db: deps.db,
        session,
        loadBytes: deps.loadBytes,
        imageToolResults: supportsImageToolResults(resolved.providerType),
      });
      return deps.runAgent({
        resolved,
        tools,
        bookTitle: title,
        startedAt: session.startedAt,
        completedAt: session.completedAt!,
        activeSeconds: readingSessionSeconds(deps.db, session.id),
      });
    })
    .then((content) => {
      if (!deps.runtime.isCurrent(session.id, generation)) return;
      saveReadingReport(deps.db, session.id, content);
      deps.runtime.succeed(session.id, generation);
    })
    .catch((err: unknown) => {
      log.warn(`generation failed for session ${session.id}`, err);
      deps.runtime.fail(session.id, { kind, reason: SAFE_FAILURE_REASON }, generation);
    });
  return { outcome: "accepted" };
}

export function saveUserReadingReport(
  deps: Pick<ReadingReportServiceDeps, "db" | "runtime">,
  sessionId: string,
  content: string,
): ReadingSessionDetailDto {
  saveReadingReport(deps.db, sessionId, content);
  deps.runtime.invalidate(sessionId);
  return getReadingSessionDetail(deps, sessionId);
}
