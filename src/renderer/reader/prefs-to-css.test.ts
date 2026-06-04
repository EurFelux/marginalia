import { describe, expect, it } from "vitest";
import { prefsToCss } from "./prefs-to-css";

describe("prefsToCss", () => {
  it("maps prefs to a body CSS rule", () => {
    const css = prefsToCss({ fontScale: 1, lineHeight: 1.9, maxWidth: 640, fontFamily: "default" });
    expect(css).toContain("font-size: 100%");
    expect(css).toContain("line-height: 1.9");
    expect(css).toContain("max-width: 640px");
    expect(css).toContain("margin: 0 auto");
  });
  it("scales font-size by fontScale", () => {
    const css = prefsToCss({
      fontScale: 1.25,
      lineHeight: 1.6,
      maxWidth: 720,
      fontFamily: "default",
    });
    expect(css).toContain("font-size: 125%");
    expect(css).toContain("max-width: 720px");
  });
});
