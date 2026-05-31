import path from "node:path";
import { app } from "electron";
import { createDb, runMigrations, type DB } from "@main/db/client";

let db: DB | undefined;

export function initDb(): DB {
  if (db) return db;
  const dbPath = path.join(app.getPath("userData"), "marginalia.db");
  // 开发期迁移目录在源码树。
  // TODO(MA-packaging): 打包期 __dirname 在 asar 内、迁移 SQL 未被 Vite 打进产物，
  // 需在打包里程碑加入 asset-copy（参考 electron-forge extraResources 把迁移目录复制到 resources/）。下面的 prod 分支是未验证的占位。
  const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(__dirname, "db/migrations");
  const candidate = createDb(dbPath);
  runMigrations(candidate, migrationsFolder);
  db = candidate;
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}
