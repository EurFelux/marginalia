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
  },
});
