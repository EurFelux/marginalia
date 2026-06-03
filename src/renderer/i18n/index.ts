// 渲染层 i18next 单例：模块体在求值时同步读 window.api（preferences 快照 + 系统 locale）来定首启语言。
// 故本模块只可从渲染进程上下文导入——切勿在无头 vitest 里 import（含间接 import 本模块的渲染层 .ts），
// 那里 window.api 为 undefined 会崩；需要时改用惰性 `await import("@renderer/i18n")` 或 mock window.api。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { sharedInitOptions } from "@shared/i18n/resources";
import { LANGS, resolveInitialLanguage, type UILanguage } from "@shared/i18n/language";
import { persistPreference } from "@renderer/store/persist-preference";

/** 按语言设 <html lang/dir>（dir 取 LANGS；今皆 ltr，将来 RTL 语言加入即自动翻转）。 */
function applyHtmlDir(code: UILanguage): void {
  const lang = LANGS.find((l) => l.code === code) ?? LANGS[0];
  document.documentElement.lang = lang.code;
  document.documentElement.dir = lang.dir;
}

const initial = resolveInitialLanguage(
  window.api.preferences.getAll().language,
  window.api.app.locale,
);

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    ...sharedInitOptions,
    lng: initial,
    react: { useSuspense: false },
  });
}
applyHtmlDir(initial);

/** 切换 UI 语言：i18next 切换 + 落盘偏好 + 重设 <html dir>。 */
export function changeUiLanguage(code: UILanguage): void {
  void i18n.changeLanguage(code);
  persistPreference({ key: "language", value: code });
  applyHtmlDir(code);
}

export default i18n;
