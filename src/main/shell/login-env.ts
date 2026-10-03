// src/main/shell/login-env.ts —— 解析用户登录 shell 的环境变量（spec 2026-10-03-bash-skills-permissions-design §6.2）。
// 从 Finder / Dock 启动的 Electron 只拿到系统最小 PATH（/usr/bin:/bin:…），brew / nvm / mise 装的命令都找不到；
// 所以首次执行命令前用 `<shell> -ilc` 抓一次环境。要带 -i：nvm、fnm、mise 常写在 .zshrc 里。
import { spawn } from "node:child_process";

export type ShellEnv =
  | { shell: string; env: Record<string, string>; source: "login" }
  /** 解析失败：退回进程环境 + 常见 Homebrew 路径，error 供调用方留 warn。 */
  | { shell: string; env: Record<string, string>; source: "fallback"; error: unknown };

/** 包住 `env -0` 输出的标记：.zshrc 等启动脚本打印的欢迎语、颜色码都在标记之外，一律丢弃。 */
const MARKER = "__MARGINALIA_ENV_7f3a__";
const RESOLVE_TIMEOUT_MS = 5000;
const FALLBACK_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function defaultShell(platform: NodeJS.Platform, envShell: string | undefined): string {
  if (envShell?.startsWith("/")) return envShell;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/** 取标记之间 `env -0` 的输出（NUL 分隔的 KEY=VALUE）；找不到成对标记返回 null。 */
export function parseEnvOutput(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(MARKER);
  const end = stdout.lastIndexOf(MARKER);
  if (start === -1 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + MARKER.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
}

/** 命令执行用的最终环境：去掉 Electron 自己的变量，关掉分页器与颜色（输出是给模型读的）。 */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("ELECTRON_")) continue;
    out[key] = value;
  }
  return { ...out, PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", TERM: "dumb" };
}

/** 解析失败时的退路：进程环境 + 缺失的常见 Homebrew 路径。 */
export function fallbackEnv(
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const parts = (processEnv.PATH ?? "").split(":").filter(Boolean);
  const missing = FALLBACK_PATHS.filter((p) => !parts.includes(p));
  return sanitizeEnv({ ...processEnv, PATH: [...parts, ...missing].join(":") });
}

/** 运行 `<shell> -ilc` 抓环境的命令文本（printf 包住 env -0，避开启动脚本的杂讯）。 */
export function loginEnvCommand(): string {
  return `printf %s ${MARKER}; env -0; printf %s ${MARKER}`;
}

/** 起一个交互式登录 shell 抓环境；超时、退出码非 0 但有完整标记时仍采用其输出。 */
export function captureLoginEnv(shell: string, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", loginEnvCommand()], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // 进程组已退出
      }
      reject(new Error(`login shell did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

export async function resolveShellEnv(deps: {
  shell: string;
  processEnv: Record<string, string | undefined>;
  capture?: (shell: string) => Promise<string>;
}): Promise<ShellEnv> {
  const capture = deps.capture ?? captureLoginEnv;
  try {
    const parsed = parseEnvOutput(await capture(deps.shell));
    if (!parsed) throw new Error("login shell printed no environment");
    return { shell: deps.shell, env: sanitizeEnv(parsed), source: "login" };
  } catch (error) {
    return { shell: deps.shell, env: fallbackEnv(deps.processEnv), source: "fallback", error };
  }
}
