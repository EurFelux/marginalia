import { defineConfig } from "vite";
import path from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // pdfjs 字体/编码资源（pdf-book.ts 的 cMapUrl/standardFontDataUrl 指向产物根下这两个目录）：
    // cmaps = CID 字体编码映射（CJK 书解码）；standard_fonts = 标准 14 字体字形（非嵌入西文字体替代）。
    // dev 模式插件经中间件同路径供给，URL 两环境一致。
    // stripBase 必须有：插件 build 输出恒保留 src 目录结构（dev 中间件却平铺）——缺它产物变成
    // cmaps/node_modules/pdfjs-dist/cmaps/*（打包冒烟实锤的生产 404）。
    viteStaticCopy({
      targets: [
        { src: "node_modules/pdfjs-dist/cmaps/*", dest: "cmaps", rename: { stripBase: true } },
        {
          src: "node_modules/pdfjs-dist/standard_fonts/*",
          dest: "standard_fonts",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@renderer", replacement: path.resolve(__dirname, "src/renderer") },
    ],
  },
  // 工作区源码包（经软链消费）不要预打包：Vite 会 bundle 进 .vite/deps 并缓存，缓存失效只看
  // lockfile/config、不看软链源码 mtime——改了包源码运行时仍用旧产物。排除后 Vite 从源码直供，
  // 源码改动即时生效、HMR 正常。
  // epub-parser 已预构建为自包含 ESM（dist/index.js，node-html-parser 等 CJS 依赖 build 期内联），
  // 故无需再 include 其 CJS 传递依赖；仍 exclude 以避软链 dist 的 stale 缓存。
  // pdf-parser 渲染层不消费（仅主进程经 Rollup bundle），不在此列。
  optimizeDeps: {
    exclude: ["@marginalia/virtual-docs", "@marginalia/epub-parser"],
  },
});
