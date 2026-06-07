// Playwright 冒烟助手（本地 eval 工具，等价 node -e：argv[2] 即代码，仅供本机终端手敲，勿喂任何不可信输入）
// 前置：dev 实例以 `pnpm start -- --remote-debugging-port=9222` 启动。
// 用法：node scripts/smoke-eval.mjs '<await 可用的 js，page 为 app 页面>'
// 例：node scripts/smoke-eval.mjs 'await page.locator("header button").count()'
// 注意：Electron 的 /json/version/ 带尾斜杠返回 400，connectOverCDP 必须传 ws URL。
import { chromium } from "playwright-core";

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => /localhost:\d+/.test(p.url()));
if (!page) {
  console.error("no app page");
  process.exit(1);
}
// oxlint-disable-next-line no-implied-eval -- 本脚本即 eval 工具（argv 即代码），输入仅来自本机终端
const fn = new Function("page", `return (async () => { return ${process.argv[2]}; })()`);
console.log(JSON.stringify(await fn(page), null, 1));
await browser.close();
