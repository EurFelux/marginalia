/**
 * LoggerService（渲染层）：与主进程同形组织——类+单例不导出，barrel 仅 createLogger。
 * 双写：DevTools console（本进程可观测面）+ 经 log:write IPC 由主进程落 renderer-*.log。
 * 级别门槛（debug 仅 dev）统一在主进程侧判定——本层全量转发。
 */
import type { LogWriteInput } from "@shared/ipc";

type LogLevel = LogWriteInput["level"];

export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  info(message: string, err?: unknown): void;
  debug(message: string, err?: unknown): void;
}

const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.log,
  debug: console.debug,
};

/** Error 展开为字符串供 IPC 传输（结构化对象过不了 contextBridge 的纯数据要求）
 * 健壮链：Error → stack/name+msg；string → 直传；其余 → JSON.stringify try/catch 兜底
 * 避免裸 JSON.stringify 对 circular/bigint throw、对 symbol/function 返回 undefined 的陷阱 */
function withErr(message: string, err?: unknown): string {
  if (err === undefined) return message;
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
  return `${message}\n${text}`;
}

/** schema 的 message.max 上限以内预截断——超长日志应截断落盘而非被校验整条拒收 */
const MESSAGE_MAX = 8192;
const MODULE_MAX = 64;

class LoggerService {
  log(level: LogLevel, module: string, message: string, err?: unknown): void {
    // DevTools console：保留原始 err 对象（可展开 inspect），格式与文件侧四段式对齐
    CONSOLE_FN[level](
      `[renderer] [${level}] [${module}] ${message}`,
      ...(err === undefined ? [] : [err]),
    );
    // IPC 落盘：fire-and-forget，失败静默——日志绝不搞崩 UI
    void window.api.log
      .write({
        level,
        module: module.slice(0, MODULE_MAX) || "renderer",
        message: withErr(message, err).slice(0, MESSAGE_MAX),
      })
      .catch(() => {});
  }
}

const service = new LoggerService();

export function createLogger(module: string): Logger {
  return {
    error: (m, e) => service.log("error", module, m, e),
    warn: (m, e) => service.log("warn", module, m, e),
    info: (m, e) => service.log("info", module, m, e),
    debug: (m, e) => service.log("debug", module, m, e),
  };
}
