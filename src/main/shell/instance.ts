// src/main/shell/instance.ts —— 登录 shell 环境的进程级缓存：首次执行命令时解析一次，之后复用。
// 解析失败的退路也缓存：否则每条命令都要再等一次 5 秒超时。
import { userInfo } from "node:os";
import { createLogger } from "@main/logger";
import { defaultShell, resolveShellEnv, type ShellEnv } from "@main/shell/login-env";

const log = createLogger("bash");

let cached: Promise<ShellEnv> | null = null;

function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

export function getShellEnv(): Promise<ShellEnv> {
  cached ??= resolveShellEnv({
    shell: defaultShell(process.platform, process.env.SHELL || accountShell()),
    processEnv: process.env,
  }).then((env) => {
    if (env.source === "fallback") {
      log.warn(
        `login shell environment unavailable for ${env.shell}; using fallback PATH`,
        env.error,
      );
    } else {
      log.info(`resolved login shell environment (${env.shell})`);
    }
    return env;
  });
  return cached;
}
