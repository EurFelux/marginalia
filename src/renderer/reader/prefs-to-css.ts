import type { ReaderPrefs } from "../types";

/**
 * 把阅读偏好转成注入每个 section iframe 的 CSS 串（承载字号/行距/正文宽度）。
 * font-size 用百分比（相对 ePub 自身字号），正文居中限宽。
 */
export function prefsToCss(prefs: ReaderPrefs): string {
  const fontPct = Math.round(prefs.fontScale * 100);
  return [
    `html { font-size: ${fontPct}%; }`,
    `body {`,
    `  line-height: ${prefs.lineHeight};`,
    `  max-width: ${prefs.maxWidth}px;`,
    `  margin: 0 auto;`,
    `  padding: 1rem;`,
    `}`,
    `img { max-width: 100%; height: auto; }`,
  ].join("\n");
}
