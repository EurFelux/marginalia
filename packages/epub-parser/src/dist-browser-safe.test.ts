import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// epub-parser 的 tsup 产物（dist/index.js）是【自包含 ESM】，被主进程(Node)与渲染层共用。
// 渲染层 vite dev 直接服务此 dist、不经 vite 的环境条件解析，故 dist 必须【浏览器安全】：
// 不得含 Node-only 顶层代码。反例（曾致 renderer 白屏）：fflate 的 "node" 导出条件含
// `import { createRequire } from "module"` + 顶层 `require("worker_threads")`，tsup 默认
// platform=node 会把它内联进 dist，浏览器求值即崩。修复＝tsup 把 fflate 别名到 browser 构建。
// 本守卫防依赖升级 / 配置回退悄悄把 Node-only 代码焊回 dist。
const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dist = readFileSync(distPath, "utf8");

describe("epub-parser dist is browser-safe", () => {
  it("does not pull the node:module builtin (createRequire shim)", () => {
    expect(dist).not.toMatch(/from\s*["']module["']/);
    expect(dist).not.toContain("createRequire");
  });

  it("does not reference the node-only worker_threads builtin", () => {
    expect(dist).not.toContain("worker_threads");
  });
});
