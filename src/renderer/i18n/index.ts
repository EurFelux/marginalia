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
