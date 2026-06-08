import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // 内联所有运行时依赖，dist 自包含、零外部 import——这是清空渲染层 vite optimizeDeps.include 的前提。
  noExternal: ["node-html-parser", "fflate", "fast-xml-parser"],
});
