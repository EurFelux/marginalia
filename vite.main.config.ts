import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@main", replacement: path.resolve(__dirname, "src/main") },
    ],
  },
  build: {
    rollupOptions: {
      // 原生 addon 不能打包：bindings 按 __dirname 相对定位 .node 文件，
      // 一旦被 Vite 内联进 .vite/build/main.js 就会丢失 node_modules/better-sqlite3
      // 的定位上下文（报 "Could not locate the bindings file"）。外置后改为运行时
      // require("better-sqlite3")，从 node_modules 解析，.node 与 bindings 上下文都正确。
      // pdfjs-dist（legacy 主进程用）与 @napi-rs/canvas（NAPI 原生件）同理外置：
      // pdfjs 内部对 @napi-rs/canvas 的条件 require 在 bundle 后会失效。
      external: ["better-sqlite3", /^pdfjs-dist/, "@napi-rs/canvas"],
    },
  },
});
