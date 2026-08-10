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
      // 直指源码入口，绕开 node_modules 软链：经软链解析时 Vite 视其为 dep，给 URL 挂 `?v=<browserHash>`
      // 并回 `Cache-Control: max-age=31536000,immutable`。browserHash 只由 configHash+lockfileHash 决定，
      // 改包源码不会变 → 同 URL 命中渲染进程强缓存，dev server 已供新代码而页面仍跑旧副本
      // （典型症状：`does not provide an export named 'xxx'`，而该 export 明明存在）。
      // 走 alias 后它是普通源码模块，无 `?v=`、无强缓存，HMR 正常。
      {
        find: "@marginalia/virtual-docs",
        replacement: path.resolve(__dirname, "packages/virtual-docs/src/index.ts"),
      },
    ],
  },
  // 工作区源码包（经软链消费）不要预打包：Vite 会 bundle 进 .vite/deps 并缓存，缓存失效只看
  // lockfile/config、不看软链源码 mtime——改了包源码运行时仍用旧产物。排除后 Vite 从源码直供，
  // 源码改动即时生效。
  // epub-parser 已预构建为自包含 ESM（dist/index.js，node-html-parser 等 CJS 依赖 build 期内联），
  // 故无需再 include 其 CJS 传递依赖；仍 exclude 以避软链 dist 的 stale 缓存。
  // 注意 exclude 只挡预打包、挡不住上面 alias 注释里说的 immutable 强缓存；epub-parser 改 dist 后
  // 若遇同类幻影 stale，清 node_modules/.vite 重启即可（其 dist 由 watcher 重建，不像源码包那样高频）。
  // virtual-docs 已走 alias 直指源码，不再需要 exclude。
  // pdf-parser 渲染层不消费（仅主进程经 Rollup bundle），不在此列。
  optimizeDeps: {
    exclude: ["@marginalia/epub-parser"],
  },
});
