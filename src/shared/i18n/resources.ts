import type { InitOptions } from "i18next";
import zhCN from "./locales/zh-CN";
import en from "./locales/en";

/** i18next init 资源（两进程共用）。键用带连字符的 BCP 47 字符串。 */
export const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
} as const;

/**
 * 两进程 i18next init 的共享项，确保 main（vanilla）与 renderer（react-i18next）配置一致。
 * keySeparator/nsSeparator 关闭 → 扁平点分键（整串如 errors.foo 即 key，便于全文搜索，
 * 与 i18next.config.ts 抽取设置和 i18next.d.ts 的 CustomTypeOptions 对齐）。
 * 调用方再补 `lng`（及 renderer 的 react 选项）。
 */
export const sharedInitOptions: InitOptions = {
  resources,
  fallbackLng: "en",
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
};
