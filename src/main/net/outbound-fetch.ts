/**
 * 进程级注入的出站 fetch。主进程启动时注入 Electron `net.fetch`（经 Chromium 网络栈、**默认采用系统代理**），
 * provider 模型请求与 DeepSeek 联网请求共用，使出站请求默认走系统代理。未注入（如 headless 测试）时
 * 返回 undefined，调用方回退全局 fetch。
 * 模块级单点注入而非逐调用透传：fetch 是横切传输关切。
 */
let injectedFetch: typeof globalThis.fetch | undefined;

/** 由主进程胶水层在 app ready 后调用一次（传 undefined 可复位，便于测试）。 */
export function setOutboundFetch(fetchImpl: typeof globalThis.fetch | undefined): void {
  injectedFetch = fetchImpl;
}

export function getOutboundFetch(): typeof globalThis.fetch | undefined {
  return injectedFetch;
}
