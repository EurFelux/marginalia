// @fontsource 切片 @font-face CSS(?inline 取字符串),注入 section iframe 用。
// iframe 是独立 document,主文档的 @font-face 对其不可见,必须随 styleCss 注入;
// 仅拼当前选中档(中文切片 CSS 文本约 100 KB/weight,每档两 weight≈200 KB,每个 iframe srcdoc 内联一份,勿全量塞)。
// 切片按 unicode-range 声明,浏览器只下载文本实际命中的 woff2,声明数百条几乎零成本。
import frauncesItalic from "@fontsource-variable/fraunces/wght-italic.css?inline";
import frauncesWght from "@fontsource-variable/fraunces/wght.css?inline";
import manropeWght from "@fontsource-variable/manrope/wght.css?inline";
import notoSansSc400 from "@fontsource/noto-sans-sc/400.css?inline";
import notoSansSc700 from "@fontsource/noto-sans-sc/700.css?inline";
import notoSerifSc400 from "@fontsource/noto-serif-sc/400.css?inline";
import notoSerifSc700 from "@fontsource/noto-serif-sc/700.css?inline";
import wenkaiBold from "lxgw-wenkai-webfont/lxgwwenkai-bold.css?inline";
import wenkaiRegular from "lxgw-wenkai-webfont/lxgwwenkai-regular.css?inline";
import type { ReaderFontFamily } from "@renderer/types";

const FONT_FACE_CSS: Record<Exclude<ReaderFontFamily, "default">, string> = {
  wenkai: [wenkaiRegular, wenkaiBold].join("\n"),
  // 正文 <em> 常见,衬线档带上 Fraunces 的 italic 轴(中文无斜体,浏览器合成)
  serif: [frauncesWght, frauncesItalic, notoSerifSc400, notoSerifSc700].join("\n"),
  sans: [manropeWght, notoSansSc400, notoSansSc700].join("\n"),
};

/** 当前档需注入 iframe 的 @font-face CSS;default 档返回空串(零干预)。 */
export function fontFaceCss(fontFamily: ReaderFontFamily): string {
  return fontFamily === "default" ? "" : FONT_FACE_CSS[fontFamily];
}
