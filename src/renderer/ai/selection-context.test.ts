// src/renderer/ai/selection-context.test.ts
import { describe, expect, it } from "vitest";
import type { Chip } from "@shared/chat";
import { selectionContextOf, withoutSelectionContext } from "@renderer/ai/selection-context";

const chip = (id: Chip["id"], tokenCount: number): Chip => ({
  id,
  labelKey: `chip.${id}`,
  content: `${id}-content`,
  tokenCount,
  state: "on",
});

describe("selectionContextOf", () => {
  it("aggregates selection + paragraph with token total", () => {
    const ctx = selectionContextOf([chip("selection", 12), chip("paragraph", 70)]);
    expect(ctx?.selection?.content).toBe("selection-content");
    expect(ctx?.paragraph?.content).toBe("paragraph-content");
    expect(ctx?.tokenTotal).toBe(82);
  });

  it("returns null when neither selection nor paragraph present", () => {
    expect(selectionContextOf([])).toBeNull();
    expect(selectionContextOf([chip("chapter-summary", 5)])).toBeNull();
  });

  it("works with selection only (paragraph deduped away upstream)", () => {
    const ctx = selectionContextOf([chip("selection", 12)]);
    expect(ctx?.paragraph).toBeNull();
    expect(ctx?.tokenTotal).toBe(12);
  });
});

describe("withoutSelectionContext", () => {
  it("removes selection and paragraph, keeps others", () => {
    const rest = withoutSelectionContext([
      chip("selection", 1),
      chip("paragraph", 2),
      chip("book-summary", 3),
    ]);
    expect(rest.map((c) => c.id)).toEqual(["book-summary"]);
  });
});
