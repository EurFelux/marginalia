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

const base = { fontScale: 1, lineHeight: 1.9, maxWidth: 640 } as const;

it("default 档不输出 font-family 规则(零干预)", () => {
  const css = prefsToCss({ ...base, fontFamily: "default" });
  expect(css).not.toContain("font-family");
});

it("非 default 档输出 !important 字体覆盖与 code/pre 等宽例外", () => {
  const css = prefsToCss({ ...base, fontFamily: "wenkai" });
  expect(css).toContain('"LXGW WenKai"');
  expect(css).toMatch(/body, body \* \{ font-family: .+ !important/);
  expect(css).toContain("code");
  expect(css).toContain("monospace");
});

it("serif/sans 档映射到对应中文字体栈", () => {
  expect(prefsToCss({ ...base, fontFamily: "serif" })).toContain('"Noto Serif SC"');
  expect(prefsToCss({ ...base, fontFamily: "sans" })).toContain('"Noto Sans SC"');
});
