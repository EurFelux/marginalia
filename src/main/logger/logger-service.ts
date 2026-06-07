/**
 * LoggerService（主进程）：级别过滤、四段式格式化、console 着色、文件落盘的统一中枢。
 * 薄实例（createLogger 产出）只持有 module 与级别方法——所有逻辑收敛在模块内单例。
 * 进程分流：main 日志 → stdout + main-*.log；renderer 日志（经 log:write IPC）→ renderer-*.log，不回显 stdout。
 * Spec: docs/superpowers/specs/2026-06-07-persistent-logging-design.md
 */
import { appService } from "../app";
import { appendLogLine, cleanupExpiredLogs, type LogSource } from "./file-sink";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** 薄 logger：只持有 module 名；可选第二参 Error 会展开 message+stack */
export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  info(message: string, err?: unknown): void;
  debug(message: string, err?: unknown): void;
}

const ANSI: Record<LogLevel, string> = {
  error: "\x1b[31m", // 红
  warn: "\x1b[33m", // 黄
  info: "\x1b[36m", // 青
  debug: "\x1b[90m", // 灰暗
};
const ANSI_RESET = "\x1b[0m";

const CONSOLE_FN: Record<LogLevel, (msg: string) => void> = {
  error: (m) => console.error(m),
  warn: (m) => console.warn(m),
  info: (m) => console.log(m),
  debug: (m) => console.log(m),
};

/** Error/unknown 展开为缩进两格的附加行；非 Error 值 JSON.stringify 兜底（不可序列化则取 "[unserializable]"） */
function formatErr(err: unknown): string {
  if (err === undefined) return "";
  let text: string;
  if (err instanceof Error) {
    text = err.stack ?? `${err.name}: ${err.message}`;
  } else if (typeof err === "string") {
    text = err;
  } else {
    try {
      text = JSON.stringify(err) ?? "[unserializable]";
    } catch {
      text = "[unserializable]";
    }
  }
  return `\n${text
    .split("\n")
    .map((l) => `  ${l.trimStart()}`)
    .join("\n")}`;
}

/** 类不导出：公共面仅 createLogger（barrel）与 writeRendererLog（log-handlers 深导入） */
class LoggerService {
  #cleanedStamp: string | null = null; // 当日已清理标记——日期翻转时再清一轮

  log(source: LogSource, level: LogLevel, module: string, message: string, err?: unknown): void {
    // 级别门槛：debug 仅 dev 记录（门槛判定统一收敛主进程侧）
    if (level === "debug" && !appService.isDev) return;

    const now = new Date();
    const line = `[${now.toISOString()}] [${source}] [${level}] [${module}] ${message}${formatErr(err)}`;

    // 恒双写之 console 侧：仅 main 来源回显 stdout——renderer 日志已在 DevTools 输出过，不混流
    if (source === "main") {
      const colored = process.stdout.isTTY ? `${ANSI[level]}${line}${ANSI_RESET}` : line;
      CONSOLE_FN[level](colored);
    }

    // 文件侧：写入失败静默降级（日志系统绝不搞崩业务）；fail-fast 的 appService 访问不在 try 里——
    // 未注入是初始化顺序 bug，应当抛
    const logsDir = appService.getPath("logsDir");
    try {
      const stamp = now.toISOString().slice(0, 10);
      if (this.#cleanedStamp !== stamp) {
        this.#cleanedStamp = stamp;
        cleanupExpiredLogs(logsDir, now);
      }
      appendLogLine(logsDir, source, line, now);
    } catch {
      if (source !== "main") CONSOLE_FN[level](line); // renderer 日志文件写失败时至少留 console 痕迹
      // main 日志已 console 输出过，文件失败静默
    }
  }
}

const service = new LoggerService();

/** 业务模块唯一入口（经 barrel）：每模块一个薄实例 */
export function createLogger(module: string): Logger {
  return {
    error: (m, e) => service.log("main", "error", module, m, e),
    warn: (m, e) => service.log("main", "warn", module, m, e),
    info: (m, e) => service.log("main", "info", module, m, e),
    debug: (m, e) => service.log("main", "debug", module, m, e),
  };
}

/** log:write IPC 专用入口（仅 log-handlers.ts 深导入，不进 barrel）：
 * 来源强制 [renderer]、落 renderer-*.log、不回显 main stdout */
export function writeRendererLog(level: LogLevel, module: string, message: string): void {
  service.log("renderer", level, module, message);
}
