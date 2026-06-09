import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** dev/prod 迁移目录解析（与历史 instance.ts 逻辑一致）。碰 Electron 全局，不在纯核心测试中调用。 */
export function resolveMigrationsFolder(): string {
  const devUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  return devUrl
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(process.resourcesPath, "migrations");
}

/** 列出迁移子目录名（字典序；目录格式 <timestamp>_<name>）。纯函数（注入 folder）。 */
export function listMigrationDirs(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 最新迁移目录名（字典序末位）；无迁移时空串。纯函数。 */
export function latestMigrationDir(folder: string): string {
  const dirs = listMigrationDirs(folder);
  return dirs.length ? dirs[dirs.length - 1] : "";
}
