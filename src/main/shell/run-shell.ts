// src/main/shell/run-shell.ts —— 执行一条 shell 命令（spec 2026-10-03-bash-skills-permissions-design §6.2）。
// 每次调用都是新 shell：stdin 关闭；单独的进程组，超时 / 中止 / 正常结束后都整组清理，不留后台进程；
// 输出封顶，去掉 ANSI 转义。不碰 Electron。
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface RunShellOptions {
  shell: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** stdout + stderr 合计上限（字符），默认 30,000。 */
  maxOutputChars?: number;
  /** SIGTERM 后等多久补 SIGKILL，默认 2,000 ms。 */
  killGraceMs?: number;
}

export interface ShellResult {
  /** 被信号结束时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** 整数毫秒。 */
  durationMs: number;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2000;

// CSI（颜色、光标）与 OSC（标题、超链接）序列。
// oxlint-disable-next-line no-control-regex -- 匹配的正是控制字符
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** 只保留开头与结尾各 half 字符的滚动缓冲：长时间刷屏的命令内存不随输出增长。 */
class HeadTail {
  #head = "";
  #tail = "";
  #total = 0;
  readonly #half: number;

  constructor(half: number) {
    this.#half = half;
  }

  push(chunk: string): void {
    this.#total += chunk.length;
    if (this.#head.length < this.#half) {
      const take = this.#half - this.#head.length;
      this.#head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (chunk) this.#tail = (this.#tail + chunk).slice(-this.#half);
  }

  get overflowed(): boolean {
    return this.#total > this.#head.length + this.#tail.length;
  }

  get head(): string {
    return this.#head;
  }

  get tail(): string {
    return this.#tail;
  }

  get total(): number {
    return this.#total;
  }
}

function omitted(n: number): string {
  return `\n… [${n} characters omitted] …\n`;
}

/** 把一段文本截到 budget：保留开头与结尾各一半，中间换成省略标记。 */
function clip(buf: HeadTail, budget: number): string {
  if (buf.total <= budget && !buf.overflowed) return buf.head + buf.tail;
  const half = Math.floor(budget / 2);
  const all = buf.head + buf.tail;
  const head = all.slice(0, half);
  const tail = budget - half > 0 ? all.slice(-(budget - half)) : "";
  return head + omitted(buf.total - head.length - tail.length) + tail;
}

/** stderr 最多分到三分之一，其余给 stdout；没用完的额度互相让出。 */
function fitOutput(
  out: HeadTail,
  err: HeadTail,
  max: number,
): { stdout: string; stderr: string; truncated: boolean } {
  if (out.total + err.total <= max && !out.overflowed && !err.overflowed) {
    return { stdout: out.head + out.tail, stderr: err.head + err.tail, truncated: false };
  }
  const errBudget = Math.min(err.total, Math.floor(max / 3));
  const outBudget = Math.min(out.total, max - errBudget);
  const errFinal = Math.min(err.total, max - outBudget);
  return { stdout: clip(out, outBudget), stderr: clip(err, errFinal), truncated: true };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH：进程组已经没有成员
  }
}

export function runShell(opts: RunShellOptions): Promise<ShellResult> {
  const max = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: true,
        durationMs: 0,
      });
      return;
    }
    const started = performance.now();
    const child = spawn(opts.shell, ["-c", opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    // 每条流各自缓冲 max 字符（首尾各半），最终再按合计上限分配。
    const out = new HeadTail(max);
    const err = new HeadTail(max);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => out.push(chunk));
    child.stderr.on("data", (chunk: string) => err.push(chunk));

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      killGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => killGroup(child.pid, "SIGKILL"), grace);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      // shell 退出后留下的后台进程（`cmd &`）一并结束：命令不得在本次调用之外继续运行。
      killGroup(child.pid, "SIGKILL");
      const fitted = fitOutput(out, err, max);
      resolve({
        exitCode: code,
        stdout: stripAnsi(fitted.stdout),
        stderr: stripAnsi(fitted.stderr),
        truncated: fitted.truncated,
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
