import type { RendererApi } from "../preload";

declare global {
  interface Window {
    api: RendererApi;
  }
}

// @fontsource 包是 side-effect CSS、无 TS 类型——声明为模块以过 typecheck。
declare module "@fontsource-variable/manrope";
declare module "@fontsource-variable/fraunces";

export {};
