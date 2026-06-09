import { appService } from "@main/app";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { resolveMigrationsFolder } from "@main/db/migrations-path";
import { ensureBuiltinProviders } from "@main/providers/default-providers";
import { createLogger } from "@main/logger";

const log = createLogger("db");

let db: DB | undefined;

export function initDb(): DB {
  if (db) return db;
  const dbPath = appService.getPath("dbFile");
  const candidate = createDb(dbPath);
  log.info("running db migrations");
  runMigrations(candidate, resolveMigrationsFolder());
  log.info("db ready");
  ensureBuiltinProviders(candidate);
  db = candidate;
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}

/** 关闭底层连接（flush WAL + 释放文件锁）。还原换库前调用，随后立即 relaunch。 */
export function closeDb(): void {
  db?.$client.close();
  db = undefined;
}
