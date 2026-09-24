// src/renderer/reader/epub-reading-context.test.ts
import { describe, expect, it } from "vitest";
import { readingContextSchema } from "@shared/chat";
import type { ReadingPosition } from "./reading-position-machine";
import { epubReadingContext } from "./epub-reading-context";

const position = (over: Partial<ReadingPosition> = {}): ReadingPosition => ({
  index: 0,
  scrollRatio: 0,
  cfi: "epubcfi(/6/2!/4/8/1:0)",
  percent: 0,
  chapterId: "ch-1",
  chapterTitle: "I. On Reading in the Margins",
  offset: 0,
  ...over,
});

describe("epubReadingContext", () => {
  it("sends a valid context before the top section has rendered (no CFI yet)", () => {
    const context = epubReadingContext(position({ cfi: null }));
    expect(context?.locator).toBeNull();
    expect(readingContextSchema.safeParse(context).success).toBe(true);
  });

  it("carries the top-of-viewport CFI as the locator", () => {
    const context = epubReadingContext(position());
    expect(context).toMatchObject({
      format: "epub",
      chapterId: "ch-1",
      spineIndex: 0,
      locator: "epubcfi(/6/2!/4/8/1:0)",
    });
    expect(readingContextSchema.safeParse(context).success).toBe(true);
  });

  it("has no context when the position is outside any chapter", () => {
    expect(epubReadingContext(position({ chapterId: null }))).toBeNull();
  });
});
