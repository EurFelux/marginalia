/**
 * file-sink：日志文件写入（按日期 + 进程来源命名）与 30 天过期清理。
 * 纯函数——logsDir 由调用方（LoggerService）注入，不依赖 appService，独立可测。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export type LogSource = "main" | "renderer";

const RETENTION_DAYS = 30;
const LOG_FILE_RE = /^(?:main|renderer)-(\d{4}-\d{2}-\d{2})\.log$/;

function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD（UTC，与行内时间戳同基准）
}

export function logFileName(source: LogSource, date: Date): string {
  return `${source}-${dateStamp(date)}.log`;
}

/** 追加一行（自动补 \n）。目录 lazy 创建；写入失败向上抛——由 LoggerService 统一降级 console */
export function appendLogLine(logsDir: string, source: LogSource, line: string, date: Date): void {
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(path.join(logsDir, logFileName(source, date)), `${line}\n`);
}

/** 删除文件名日期早于 30 天的日志；非日志命名的文件不动。目录不存在则 no-op */
export function cleanupExpiredLogs(logsDir: string, now: Date): void {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return; // 目录不存在等——清理是 best-effort
  }
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStamp = dateStamp(cutoff);
  for (const name of entries) {
    const m = LOG_FILE_RE.exec(name);
    if (m && m[1] < cutoffStamp) {
      try {
        rmSync(path.join(logsDir, name));
      } catch {
        // best-effort：单个文件删除失败不阻塞其余清理
      }
    }
  }
}
