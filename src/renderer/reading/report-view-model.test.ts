import { describe, expect, it } from "vitest";
import { reportViewModel } from "@renderer/reading/report-view-model";

describe("reportViewModel", () => {
  it.each([
    [
      "empty",
      { status: "empty" },
      { content: null, busy: false, canGenerate: true, canEdit: true, error: null },
    ],
    [
      "generating",
      { status: "generating" },
      { content: null, busy: true, canGenerate: false, canEdit: false, error: null },
    ],
    [
      "generation-failed",
      { status: "generation-failed", reason: "model unavailable" },
      { content: null, busy: false, canGenerate: true, canEdit: true, error: "model unavailable" },
    ],
    [
      "ready",
      { status: "ready", content: "# Report" },
      { content: "# Report", busy: false, canGenerate: true, canEdit: true, error: null },
    ],
    [
      "regenerating",
      { status: "regenerating", content: "# Earlier report" },
      { content: "# Earlier report", busy: true, canGenerate: false, canEdit: false, error: null },
    ],
    [
      "regeneration-failed",
      { status: "regeneration-failed", content: "# Earlier report", reason: "network error" },
      {
        content: "# Earlier report",
        busy: false,
        canGenerate: true,
        canEdit: true,
        error: "network error",
      },
    ],
  ] as const)("projects %s state", (_status, state, expected) => {
    expect(reportViewModel(state)).toEqual(expected);
  });
});
