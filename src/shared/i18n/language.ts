import { z } from "zod";

/** UI 语言（BCP 47）。源语言 zh-CN，回退 en。 */
export const uiLanguage = z.enum(["zh-CN", "en"]);
export type UILanguage = z.infer<typeof uiLanguage>;

/** 语言元数据：code + 本族名 label + 书写方向（今皆 ltr；加 RTL 语言时新增 dir:"rtl" 一条即可）。 */
export const LANGS: { code: UILanguage; label: string; dir: "ltr" | "rtl" }[] = [
  { code: "zh-CN", label: "中文", dir: "ltr" },
  { code: "en", label: "English", dir: "ltr" },
];

/** 系统 locale → 支持语言：zh* → zh-CN（只发简体），其余 → en。 */
export function matchSystemLanguage(locale: string): UILanguage {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** 首启语言：已存偏好优先，否则按系统 locale 匹配。 */
export function resolveInitialLanguage(
  stored: UILanguage | undefined,
  systemLocale: string,
): UILanguage {
  return stored ?? matchSystemLanguage(systemLocale);
}
