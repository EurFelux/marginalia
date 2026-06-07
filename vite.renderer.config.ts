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
    viteStaticCopy({
      targets: [
        { src: "node_modules/pdfjs-dist/cmaps/*", dest: "cmaps" },
        { src: "node_modules/pdfjs-dist/standard_fonts/*", dest: "standard_fonts" },
      ],
    }),
  ],
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
