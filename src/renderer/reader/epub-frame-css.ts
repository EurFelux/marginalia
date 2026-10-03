import type { ReaderPrefs } from "@renderer/types";
import { SEARCH_HIGHLIGHT_CSS } from "./epub-search";
import { ANNO_IFRAME_CSS } from "./highlight";
import { prefsToCss } from "./prefs-to-css";
import { fontFaceCss } from "./reader-fonts";
import { readerThemeCss } from "./reader-theme-css";
import { TTS_IFRAME_CSS } from "./tts/tts-css";

/** EpubReader 注入 section iframe 的样式，按 VirtualDocs 的两路通道拆分。 */
export function epubFrameCss(
  prefs: ReaderPrefs,
  isDark: boolean,
): { styleCss: string; paintCss: string } {
  return {
    styleCss: [
      fontFaceCss(prefs.fontFamily),
      prefsToCss(prefs),
      ANNO_IFRAME_CSS,
      TTS_IFRAME_CSS,
      SEARCH_HIGHLIGHT_CSS,
    ].join("\n"),
    // 主题只改配色，走不重载的 paint 通道：跟随系统的明暗切换在阅读中无操作时发生，
    // 若进 styleCss 会让全部 iframe 重载、视口丢失阅读位置并被存盘（#115）。
    paintCss: readerThemeCss(isDark),
  };
}
