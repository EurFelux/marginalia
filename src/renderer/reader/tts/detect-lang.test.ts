import { describe, expect, it } from "vitest";
import { detectParagraphLang } from "./detect-lang";

describe("detectParagraphLang", () => {
  it("detects Chinese paragraphs", () => {
    expect(detectParagraphLang("这是一个完整的中文段落，讲述了一个故事。")).toBe("zh");
  });
  it("detects English paragraphs", () => {
    expect(detectParagraphLang("This is a plain English paragraph about reading.")).toBe("en");
  });
  it("detects Japanese via kana even with heavy kanji", () => {
    expect(detectParagraphLang("吾輩は猫である。名前はまだ無い。")).toBe("ja");
  });
  it("mixed Chinese with embedded English terms stays zh", () => {
    expect(detectParagraphLang("我们用 TypeScript 和 React 构建了这个阅读器应用。")).toBe("zh");
  });
  it("mostly-English with a few CJK chars stays en", () => {
    expect(
      detectParagraphLang("The word 猫 means cat in this long English sentence about languages."),
    ).toBe("en");
  });
  it("falls back to en for digits/punctuation-only text", () => {
    expect(detectParagraphLang("1234 — 5678!")).toBe("en");
  });
});
