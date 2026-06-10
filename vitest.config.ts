import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@main", replacement: path.resolve(__dirname, "src/main") },
      { find: "@renderer", replacement: path.resolve(__dirname, "src/renderer") },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // 绝对路径：无自有 config 的子包（如 pdf-parser）单独跑 vitest 时会向上解析到本 config，
    // 相对路径会按子包 cwd 解析而 miss（test:all 曾因此挂）；绝对路径让两种入口行为一致。
    setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
  },
});
