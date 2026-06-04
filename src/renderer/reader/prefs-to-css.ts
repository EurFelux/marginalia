import type { ReaderPrefs } from "../types";
import { FONT_STACKS, MONO_STACK } from "./font-stacks";

/**
 * 把阅读偏好转成注入每个 section iframe 的 CSS 串(承载字号/行距/正文宽度/字体)。
 *
 * 注入位置在 ePub 自身样式之前(见 SectionFrame.buildSrcDoc),且 ePub 常在 `p`/`div`
 * 等元素上**直接**设 `line-height`/`margin`/`font-family`(直接命中元素优先于从 `body`
 * 继承),因此用户偏好必须用 `!important` 才能覆盖 ePub 自带样式;`line-height` 还需
 * **直接命中正文块**(仅设 `body` 够不到那些元素),标题不在其列以保紧凑。
 * `font-size` 设在 `html` 上以百分比缩放(ePub 极少改 `html` 字号),经 rem/em 级联即可,
 * 无需 `!important`。
 * 字体覆盖须 `body *` 全命中,并紧随其后给 code/pre 恢复等宽(更特异且靠后,稳赢);
 * `default` 档零干预(不输出 font-family 规则,保留原书字体)。
 */
export function prefsToCss(prefs: ReaderPrefs): string {
  const fontPct = Math.round(prefs.fontScale * 100);
  const rules = [
    `html { font-size: ${fontPct}%; }`,
    `body {`,
    `  max-width: ${prefs.maxWidth}px !important;`,
    `  margin: 0 auto !important;`,
    `  padding: 1rem !important;`,
    `}`,
    `body p, body div, body li, body blockquote, body dd, body dt, body td, body th {`,
    `  line-height: ${prefs.lineHeight} !important;`,
    `}`,
    `img { max-width: 100%; height: auto; }`,
  ];
  if (prefs.fontFamily !== "default") {
    rules.push(
      `body, body * { font-family: ${FONT_STACKS[prefs.fontFamily]} !important; }`,
      `body :is(code, pre, samp, kbd), body :is(code, pre) * { font-family: ${MONO_STACK} !important; }`,
    );
  }
  return rules.join("\n");
}
