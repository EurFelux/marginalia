/** barrel：仅 re-export createLogger——渲染层业务代码唯一入口（与主进程 logger 同形）。 */
export { createLogger } from "./logger-service";
