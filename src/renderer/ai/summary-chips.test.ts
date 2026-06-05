import { describe, expect, it } from "vitest";
import { materializeSummaryChips } from "@renderer/ai/summary-chips";

describe("materializeSummaryChips", () => {
  it("materializes only enabled+ready summaries", () => {
    const chips = materializeSummaryChips(
      { chapter: true, book: true },
      { status: "ready", summary: "章摘" },
      { status: "generating", summary: null },
    );
    expect(chips.map((c) => c.id)).toEqual(["chapter-summary"]);
    expect(chips[0].content).toBe("章摘");
    expect(chips[0].state).toBe("on");
  });

  it("returns empty when toggles are off even if summaries are ready", () => {
    const chips = materializeSummaryChips(
      { chapter: false, book: false },
      { status: "ready", summary: "x" },
      { status: "ready", summary: "y" },
    );
    expect(chips).toEqual([]);
  });

  it("materializes both when both enabled and ready", () => {
    const chips = materializeSummaryChips(
      { chapter: true, book: true },
      { status: "ready", summary: "章节内容" },
      { status: "ready", summary: "全书内容" },
    );
    expect(chips.map((c) => c.id)).toEqual(["book-summary", "chapter-summary"]);
    expect(chips[0].tokenCount).toBeGreaterThan(0);
    expect(chips[1].tokenCount).toBeGreaterThan(0);
  });

  it("skips chapter with null summary even if status is ready", () => {
    const chips = materializeSummaryChips(
      { chapter: true, book: false },
      { status: "ready", summary: null },
      undefined,
    );
    expect(chips).toEqual([]);
  });

  it("skips when summary view is undefined", () => {
    const chips = materializeSummaryChips({ chapter: true, book: true }, undefined, undefined);
    expect(chips).toEqual([]);
  });
});
