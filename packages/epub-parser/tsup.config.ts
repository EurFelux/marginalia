import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // 刻意不 clean：`pnpm dev` 跑着时，另开终端的 `pnpm test` / `pnpm typecheck` 会各自前置一次
  // `build:packages`，clean 让 dist/ 消失约 40ms——这期间 vite dev server 若重建主进程 bundle
  // （两者都由「刚保存了 src/main 下的文件」触发，撞上的概率远高于该窗口的随机概率），就会报
  // `Rolldown failed to resolve import "@marginalia/epub-parser"` 并中断热更新。
  // 覆盖写是原子的，故不 clean 时产物永远完整可解析。entry 固定为单个 src/index.ts、产物文件名
  // 恒定，不存在陈旧残留；真要清理直接删 dist/ 即可。
  clean: false,
  // 内联所有运行时依赖，dist 自包含、零外部 import——这是清空渲染层 vite optimizeDeps.include 的前提。
  noExternal: ["node-html-parser", "fflate", "fast-xml-parser"],
  esbuildOptions(options) {
    // fflate 别名到其 browser 构建。fflate 的 "node" 导出条件（tsup 默认 platform=node 会命中）
    // 含顶层 `import { createRequire } from "module"` + `require("worker_threads")`，内联进这份
    // 【主进程(Node)与渲染层共用】的自包含 dist 后，会在渲染层（vite dev 直接服务 dist、不经条件
    // 解析）求值即崩——module 被浏览器外部化、访问 createRequire 抛错 → renderer 整屏白。
    // browser 构建无 Node-only 顶层代码，且同步 API（unzipSync/strFromU8/strToU8/zipSync）实现一致、
    // 在 Node 下同样可用。dist-browser-safe.test.ts 守住这条不变量。
    //
    // ⚠️ 约束（有意接受）：本 dist 因此只能用 fflate 的【同步】API。browser 构建的【异步】API 靠
    // web `Worker`+blob URL，而 Electron 主进程是 Node（无全局 Worker）会崩。现实里 epub 解析在主进程，
    // 提速方向是把同步解析整体挪进 worker_thread（sync-in-worker，不阻塞主线程），本就不需要 fflate async。
    // 若将来确需 fflate 异步，应改为按环境出双构建（node/browser 条件导出），而非在此放开。
    options.alias = { ...options.alias, fflate: "fflate/browser" };
  },
});
