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
    keySeparator: ".",
    nsSeparator: ":",
    defaultValue: "",
    sort: true,
  },
});
