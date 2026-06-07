import "@fontsource-variable/manrope";
import "@fontsource-variable/fraunces";
import "./index.css";
import "@renderer/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@renderer/query/client";
import { useThemeStore } from "@renderer/store/theme-store";
import { App } from "@renderer/App";
import { ErrorBoundary } from "@renderer/ErrorBoundary";
import { createLogger } from "@renderer/logger";

// 首帧前按 theme-store 初始 resolvedTheme 挂 .dark（store 已从 preload 快照 + matchMedia 解析好）。
// 放此处而非 preload：sandbox preload 模块求值时 document.documentElement 尚为 null；renderer 入口时
// DOM 已就绪、index.css 已注入，且在 createRoot 之前同步执行——零首帧闪白。
document.documentElement.classList.toggle(
  "dark",
  useThemeStore.getState().resolvedTheme === "dark",
);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("renderer: #root not found");

// 全局错误 funnel：组件生命周期之外的错误也留痕（boundary 只覆盖渲染树内）
const windowLog = createLogger("window");
window.onerror = (message, source, lineno, colno, error) => {
  const msg = typeof message === "string" ? message : "script error";
  windowLog.error(`${msg} (${source ?? "?"}:${lineno ?? 0}:${colno ?? 0})`, error);
};
window.addEventListener("unhandledrejection", (ev) => {
  windowLog.error("unhandled promise rejection", ev.reason);
});

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
