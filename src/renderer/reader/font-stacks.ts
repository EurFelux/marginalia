import type { ReaderFontFamily } from "@renderer/types";

/**
 * 非 default 档的正文字体栈:西文专用字体在前、打包中文字体回退、系统兜底。
 * 文楷自带拉丁字形,不与西文字体混搭以保风格统一。
 */
export const FONT_STACKS: Record<Exclude<ReaderFontFamily, "default">, string> = {
  wenkai: `"LXGW WenKai", "Songti SC", serif`,
  serif: `"Fraunces Variable", "Noto Serif SC", Georgia, serif`,
  sans: `"Manrope Variable", "Noto Sans SC", system-ui, sans-serif`,
};

/** code/pre 等宽例外栈(字体覆盖时恢复,免代码块被正文字体破坏)。 */
export const MONO_STACK = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
