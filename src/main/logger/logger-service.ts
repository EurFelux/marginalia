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

const MODULE_MAX = 64;
const BODY_MAX = 8192;

/** Error/unknown 展开为附加行（缩进统一由 normalizeBody 做）；非 Error 值 JSON.stringify 兜底 */
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
  return `\n${text}`;
}

/** module 折叠为单行并截断——防经 IPC 注入换行/超长破坏四段式头（schema 限长是第一层，这里兜内部调用） */
function sanitizeModule(module: string): string {
  return module.replace(/\s+/g, " ").trim().slice(0, MODULE_MAX);
}

/** body（message + err 展开）规范化：超长截断；非首行统一缩进两格——
 * 保持四段式首行可 grep，也让多行 message 无法注入顶格的伪造日志行 */
function normalizeBody(body: string): string {
  const capped = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…[truncated]` : body;
  const [first = "", ...rest] = capped.split("\n");
  if (rest.length === 0) return first;
  return [first, ...rest.map((l) => `  ${l.trimStart()}`)].join("\n");
}

/** 类不导出：公共面仅 createLogger（barrel）与 writeRendererLog（log-handlers 深导入） */
class LoggerService {
  #cleanedStamp: string | null = null; // 当日已清理标记——日期翻转时再清一轮

  log(source: LogSource, level: LogLevel, module: string, message: string, err?: unknown): void {
    // 级别门槛：debug 仅 dev 记录（门槛判定统一收敛主进程侧）
    if (level === "debug" && !appService.isDev) return;

    const now = new Date();
    const body = normalizeBody(`${message}${formatErr(err)}`);
    const line = `[${now.toISOString()}] [${source}] [${level}] [${sanitizeModule(module)}] ${body}`;

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
