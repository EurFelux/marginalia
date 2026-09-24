// src/renderer/reader/epub-reading-context.ts
import type { ReadingContext } from "@shared/chat";
import type { ReadingPosition } from "./reading-position-machine";

const CURRENT_EPUB_READ_CHARS = 4_000;

/** 阅读位置 → 随提问发送的 readingContext；位置不在任何章节内时无上下文。 */
export function epubReadingContext(
  position: ReadingPosition,
): Extract<ReadingContext, { format: "epub" }> | null {
  if (position.chapterId == null) return null;
  return {
    format: "epub",
    chapterId: position.chapterId,
    chapterTitle: position.chapterTitle,
    offset: position.offset,
    maxChars: CURRENT_EPUB_READ_CHARS,
    spineIndex: position.index,
    locator: position.cfi,
  };
}
