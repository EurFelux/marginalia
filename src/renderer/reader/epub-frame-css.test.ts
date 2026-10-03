import { describe, expect, it } from "vitest";
import type { ReaderPrefs } from "@renderer/types";
import { epubFrameCss } from "./epub-frame-css";

const prefs: ReaderPrefs = { fontScale: 1.2, lineHeight: 1.9, maxWidth: 740, fontFamily: "serif" };

describe("epubFrameCss", () => {
  // styleCss 变化 = 所有 section iframe 重载 + 测高缓存清空 → 阅读位置丢失（#115）。
  // 跟随系统的明暗切换每天都会在无操作时发生，故主题绝不能进入 styleCss。
  it("keeps styleCss identical across light and dark themes", () => {
    expect(epubFrameCss(prefs, true).styleCss).toBe(epubFrameCss(prefs, false).styleCss);
  });

  it("carries the theme in paintCss instead", () => {
    expect(epubFrameCss(prefs, true).paintCss).not.toBe(epubFrameCss(prefs, false).paintCss);
  });

  it("still changes styleCss for layout prefs", () => {
    const bigger = { ...prefs, fontScale: 1.4 };
    expect(epubFrameCss(bigger, false).styleCss).not.toBe(epubFrameCss(prefs, false).styleCss);
  });
});
