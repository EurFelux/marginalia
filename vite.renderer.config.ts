import { defineConfig } from "vite";
import path from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@renderer", replacement: path.resolve(__dirname, "src/renderer") },
    ],
  },
  // 工作区源码包（main/exports 直指 src/*.ts，经软链消费）不要预打包：
  // 否则 Vite 会把它 bundle 进 .vite/deps 并缓存，缓存失效只看 lockfile/config、
  // 不看软链源码 mtime——改了包的源码（如新增 VirtualDocs.redecorate）运行时仍用旧产物。
  // 排除后由 Vite 直接从源码转译直供，源码改动即时生效、HMR 正常。
  optimizeDeps: {
    exclude: ["@marginalia/virtual-docs"],
  },
});
