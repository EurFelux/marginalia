#!/usr/bin/env node
/**
 * 临时性能实验自动化：通过 CDP 连接 dev 模式下的 Marginalia，
 * 依次打开 50/200/500/1000 条消息的测试会话，截图并采集 console 日志。
 *
 * 前置：
 *   ./node_modules/.bin/electron-forge start -- --remote-debugging-port=9222
 *
 * 运行：
 *   node scripts/perf-snapshot.mjs --complexity short
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CDP_HTTP = "http://127.0.0.1:9222";
const OUT_DIR = "/tmp/marginalia-perf-snapshots";

fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const complexityFlag = args.includes("--complexity")
  ? args[args.indexOf("--complexity") + 1]
  : "mixed";
const complexity = ["short", "long", "code", "mixed"].includes(complexityFlag)
  ? complexityFlag
  : "mixed";

const targets = [50, 200, 500, 1000].map((n) => ({
  title: `perf-test-${n}-${complexity}`,
  name: `${n}-${complexity}`,
}));

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function snapshot(page, target) {
  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

  // Marginalia 启动后默认在 library 视图。
  // 1. 点击右下角浮动助手按钮。
  await page.click('[aria-label*="问问"]', { timeout: 10000 });
  await sleep(500);

  // 2. 打开会话列表。
  await page.click('[aria-label="会话列表"]');
  await sleep(300);

  // 3. 点击目标会话标题。
  await page.click(`text=${target.title}`);
  await sleep(6500); // 给消息列表和 markdown 渲染留出时间，并等待 ChatPerf 5s 周期输出

  // 4. 截图（初始状态）。
  await page.screenshot({
    path: path.join(OUT_DIR, `ai-${target.name}-initial.png`),
    fullPage: false,
  });

  // 5. 滚动到底部再回顶部，触发滚动 FPS 测量。
  await page.evaluate(() => {
    const viewport = document.querySelector("[data-radix-scroll-area-viewport]");
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    }
  });
  await sleep(1500);

  await page.evaluate(() => {
    const viewport = document.querySelector("[data-radix-scroll-area-viewport]");
    if (viewport) {
      viewport.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
  await sleep(1500);

  // 6. 截图（滚动后）。
  await page.screenshot({
    path: path.join(OUT_DIR, `ai-${target.name}-scrolled.png`),
    fullPage: false,
  });

  // 7. 关闭 AI 面板，便于下一次循环重新打开。
  await page.click('[aria-label="关闭面板"]');
  await sleep(300);

  fs.writeFileSync(path.join(OUT_DIR, `ai-${target.name}-console.log`), logs.join("\n"));
  console.log(`Done: ${target.title}`);
}

(async () => {
  const versionRes = await fetch(`${CDP_HTTP}/json/version`);
  const version = await versionRes.json();
  const cdpWs = version.webSocketDebuggerUrl;
  console.log("CDP ws:", cdpWs);

  const browser = await chromium.connectOverCDP(cdpWs);
  console.log("Connected to CDP");

  const context = browser.contexts()[0];
  if (!context) {
    console.error("No browser context found");
    process.exit(1);
  }

  // 关闭 dev 模式下自动打开的 DevTools 面板，避免它遮住主窗口。
  for (const p of context.pages()) {
    if (p.url().startsWith("devtools://")) await p.close();
  }

  const pages = context.pages().filter((p) => !p.url().startsWith("devtools://"));
  const page = pages[0];
  if (!page) {
    console.error("No existing page found");
    process.exit(1);
  }

  for (const target of targets) {
    await snapshot(page, target).catch((err) => {
      console.error(`Failed ${target.title}:`, err.message);
    });
  }

  await browser.close();
  console.log(`Snapshots saved to ${OUT_DIR}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
