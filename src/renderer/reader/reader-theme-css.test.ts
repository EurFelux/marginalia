import { describe, expect, it } from "vitest";
import { readerThemeCss } from "@renderer/reader/reader-theme-css";

describe("readerThemeCss", () => {
  it("returns empty string for light (keep ePub paper styling)", () => {
    expect(readerThemeCss(false)).toBe("");
  });

  it("returns dark overrides for dark", () => {
    const css = readerThemeCss(true);
    expect(css).toContain("background-color: #15181c");
    expect(css).toContain("color: #c9cdd1");
    expect(css).toContain("!important");
    expect(css).toContain("img { filter: brightness(0.9); }");
  });
});
