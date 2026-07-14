import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["zh-CN", "en"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "src/shared/i18n/locales/{{language}}.ts",
    outputFormat: "ts",
    // 单一默认命名空间 + 扁平输出：defaultNS:false 让 extract 不生成 `translation` 包裹层，
    // 直接产出 flat `{ common, errors }`（与 resources.ts 在外层包 `{ translation: ... }` 的约定吻合）。
    // 切勿改回 mergeNamespaces:true——那会把键塞进 `translation` 顶层键、并因形状不匹配把 en 译文清空。
    defaultNS: false,
    primaryLanguage: "zh-CN",
    // 扁平点分键：键不嵌套，输出 `"errors.providerNotFound": "..."`。便于全文搜索——
    // 搜 `errors.providerNotFound` 同时命中源码 t() 调用处与 locale 定义处。运行时 init
    // 与 i18next.d.ts 的 CustomTypeOptions 必须同样 keySeparator/nsSeparator:false 才能对上。
    keySeparator: false,
    nsSeparator: false,
    defaultValue: "",
    sort: true,
    // 术语键只被其他文案的 $t(terms.provider) 嵌套引用、无源码 t() 调用，
    // 默认会被 removeUnusedKeys 剪掉；用 preservePatterns 保住整个 terms.* 子树。
    preservePatterns: [
      "terms.*",
      "reading.openReference",
      "settings.backup.confirm*",
      "settings.backup.kind*",
    ],
  },
});
