import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["zh-CN", "en"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "src/shared/i18n/locales/{{language}}.ts",
    outputFormat: "ts",
    mergeNamespaces: true,
    primaryLanguage: "zh-CN",
    keySeparator: ".",
    nsSeparator: ":",
    defaultValue: "",
    sort: true,
  },
});
