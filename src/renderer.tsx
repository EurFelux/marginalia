import "@fontsource-variable/manrope";
import "@fontsource-variable/fraunces";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@renderer/query/client";
import { App } from "@renderer/App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("renderer: #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
