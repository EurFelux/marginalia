/** barrel：仅 re-export createLogger——业务代码唯一入口。
 * writeRendererLog（IPC 胶水专用）有意不进 barrel（log-handlers.ts 深导入 logger/logger-service）。 */
export { createLogger } from "./logger-service";
