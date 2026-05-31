import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [{ find: "@shared", replacement: path.resolve(__dirname, "src/shared") }],
  },
});
