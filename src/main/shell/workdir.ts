// src/main/shell/workdir.ts —— 命令工作目录（spec 2026-10-03-bash-skills-permissions-design §6.2）。
import { mkdir, stat } from "node:fs/promises";

/**
 * 用户设了目录就用它（必须已存在且是文件夹，不替用户建）；没设用默认工作区，不存在则创建。
 * 错误信息是给模型看的：要说清楚用户去哪改。
 */
export async function resolveWorkdir(custom: string | null, defaultDir: string): Promise<string> {
  if (!custom) {
    await mkdir(defaultDir, { recursive: true });
    return defaultDir;
  }
  const info = await stat(custom).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(
      `The working directory "${custom}" does not exist or is not a folder. Tell the user to fix it in Settings › Commands.`,
    );
  }
  return custom;
}
