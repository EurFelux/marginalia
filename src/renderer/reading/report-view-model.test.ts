import { describe, expect, it } from "vitest";
import { reportViewModel } from "@renderer/reading/report-view-model";

const step = {
  id: "1",
  tool: "listAnnotations",
  startedAt: 1_000,
  endedAt: 2_000,
  outcome: "ok",
  count: 24,
} as const;

describe("reportViewModel", () => {
  it.each([
    [
      "empty",
      { status: "empty" },
      {
        content: null,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: null,
        progress: [],
        startedAt: null,
      },
    ],
    [
      "generating",
      { status: "generating", startedAt: 1_000, progress: [] },
      {
        content: null,
        busy: true,
        canGenerate: false,
        canEdit: false,
        canCancel: true,
        error: null,
        progress: [],
        startedAt: 1_000,
      },
    ],
    [
      "generation-failed",
      { status: "generation-failed", progress: [step] },
      {
        content: null,
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: "generation-failed",
        progress: [step],
        startedAt: null,
      },
    ],
    [
      "ready",
      { status: "ready", content: "# Report" },
      {
        content: "# Report",
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: null,
        progress: [],
        startedAt: null,
      },
    ],
    [
      "regenerating",
      { status: "regenerating", content: "# Earlier report", startedAt: 2_000, progress: [step] },
      {
        content: "# Earlier report",
        busy: true,
        canGenerate: false,
        canEdit: false,
        canCancel: true,
        error: null,
        progress: [step],
        startedAt: 2_000,
      },
    ],
    [
      "regeneration-failed",
      { status: "regeneration-failed", content: "# Earlier report", progress: [step] },
      {
        content: "# Earlier report",
        busy: false,
        canGenerate: true,
        canEdit: true,
        canCancel: false,
        error: "regeneration-failed",
        progress: [step],
        startedAt: null,
      },
    ],
  ] as const)("projects %s state", (_status, state, expected) => {
    expect(reportViewModel(state)).toEqual(expected);
  });
});
