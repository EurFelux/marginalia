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

// 首帧前按 theme-store 初始 resolvedTheme 挂 .dark（store 已从 preload 快照 + matchMedia 解析好）。
// 放此处而非 preload：sandbox preload 模块求值时 document.documentElement 尚为 null；renderer 入口时
// DOM 已就绪、index.css 已注入，且在 createRoot 之前同步执行——零首帧闪白。
document.documentElement.classList.toggle(
  "dark",
  useThemeStore.getState().resolvedTheme === "dark",
);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("renderer: #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
