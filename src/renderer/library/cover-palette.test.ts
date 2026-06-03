import { describe, expect, it } from "vitest";
import { COVER_GRADIENTS, coverGradientClass } from "./cover-palette";

describe("coverGradientClass", () => {
  it("is deterministic: same id → same class", () => {
    expect(coverGradientClass("urn:uuid:abc")).toBe(coverGradientClass("urn:uuid:abc"));
  });

  it("always returns a palette member", () => {
    for (const id of ["a", "book-1", "urn:uuid:xyz", "", "🐱"]) {
      expect(COVER_GRADIENTS).toContain(coverGradientClass(id));
    }
  });

  it("spreads across the palette (not all ids collapse to one class)", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `book-${i}`);
    const distinct = new Set(ids.map(coverGradientClass));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
