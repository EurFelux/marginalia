import type { RendererApi } from "../preload";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
