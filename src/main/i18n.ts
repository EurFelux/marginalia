import i18next from "i18next";
import { sharedInitOptions } from "@shared/i18n/resources";
import type { UILanguage } from "@shared/i18n/language";

// 主进程独立的 vanilla i18next 实例（不依赖 react）。只用于本地化「自产」错误消息。
const main = i18next.createInstance();

/** 启动时按解析出的语言同步 init（幂等）。 */
export function initMainI18n(language: UILanguage): void {
  if (!main.isInitialized) {
    void main.init({ ...sharedInitOptions, lng: language });
  } else {
    void main.changeLanguage(language);
  }
}

/** 运行时切换主进程语言（偏好变更时调）。 */
export function setMainLanguage(language: UILanguage): void {
  void main.changeLanguage(language);
}

/** 主进程翻译函数（已由 @shared/i18n/i18next.d.ts 类型化键）。 */
export const t = main.t.bind(main);
