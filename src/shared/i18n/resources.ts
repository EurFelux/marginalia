import zhCN from "./locales/zh-CN";
import en from "./locales/en";

/** i18next init 资源（两进程共用）。键用带连字符的 BCP 47 字符串。 */
export const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
} as const;
