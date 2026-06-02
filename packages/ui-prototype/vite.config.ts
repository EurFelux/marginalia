import path from "node:path";

import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@marginalia/virtual-docs": path.resolve(__dirname, "../virtual-docs/src/index.ts"),
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    // 原型为纯前端 UI，不需要 SSR：开 SPA 模式（应用内容纯客户端渲染，规避水合不匹配）
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
});

export default config;
