import { describe, expect, it } from "vitest";
import { parseEpub } from "@marginalia/epub-parser";
import { buildSampleEpub } from "@main/onboarding/sample-book";

describe("buildSampleEpub", () => {
  it("builds a valid 3-chapter English book", () => {
    const parsed = parseEpub(buildSampleEpub("en"));
    expect(parsed.title).toMatch(/Margin/);
    expect(parsed.spine.length).toBe(3);
    expect(parsed.toc.length).toBe(3);
  });

  it("builds a valid 3-chapter Chinese book", () => {
    const parsed = parseEpub(buildSampleEpub("zh-CN"));
    expect(parsed.title).toMatch(/页边/);
    expect(parsed.spine.length).toBe(3);
    expect(parsed.toc.length).toBe(3);
  });

  it("English and Chinese builds differ", () => {
    expect(buildSampleEpub("en")).not.toEqual(buildSampleEpub("zh-CN"));
  });
});
