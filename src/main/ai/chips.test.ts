// src/main/ai/chips.test.ts
import { describe, expect, it } from "vitest";
import { buildChips, dedupeParagraph } from "@main/ai/chips";

describe("buildChips", () => {
  it("builds a selection chip and a paragraph chip", () => {
    const chips = buildChips({
      selection: "the cat sat",
      paragraphBefore: "before.",
      paragraphCurrent: "the cat sat on the mat.",
      paragraphAfter: "after.",
    });
    expect(chips.map((c) => c.id)).toEqual(["selection", "paragraph"]);
    const selection = chips[0];
    expect(selection).toMatchObject({
      id: "selection",
      labelKey: "chip.selection",
      content: "the cat sat",
      required: true,
      enabled: true,
    });
    expect(selection.tokenCount).toBeGreaterThan(0);
    // 段落 = before + current + after，用空行连接
    expect(chips[1].content).toBe("before.\n\nthe cat sat on the mat.\n\nafter.");
  });

  it("omits the paragraph chip when there is no paragraph text", () => {
    const chips = buildChips({
      selection: "lone selection",
      paragraphBefore: null,
      paragraphCurrent: "   ",
      paragraphAfter: null,
    });
    expect(chips.map((c) => c.id)).toEqual(["selection"]);
  });

  it("trims selection and paragraph pieces", () => {
    const chips = buildChips({
      selection: "  trimmed  ",
      paragraphCurrent: "  only current  ",
    });
    expect(chips[0].content).toBe("trimmed");
    expect(chips[1].content).toBe("only current");
  });
});

describe("dedupeParagraph", () => {
  const sample = buildChips({
    selection: "s",
    paragraphCurrent: "shared paragraph",
  });

  it("returns chips unchanged when there is no previous paragraph", () => {
    expect(dedupeParagraph(sample, null)).toEqual(sample);
  });

  it("drops the paragraph chip when its content matches the previous one", () => {
    const result = dedupeParagraph(sample, "shared paragraph");
    expect(result.map((c) => c.id)).toEqual(["selection"]);
  });

  it("keeps the paragraph chip when content differs", () => {
    const result = dedupeParagraph(sample, "a different paragraph");
    expect(result.map((c) => c.id)).toEqual(["selection", "paragraph"]);
  });
});
