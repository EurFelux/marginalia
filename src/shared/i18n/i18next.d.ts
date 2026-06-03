import "i18next";
import type zhCN from "./locales/zh-CN";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    // 与运行时（sharedInitOptions）一致：扁平点分键，i18next 不再按 "." 拆 key，
    // 故 typeof zhCN 的字面量键（形如 errors.foo）直接成为合法 t() key。
    keySeparator: false;
    resources: { translation: typeof zhCN };
  }
}
