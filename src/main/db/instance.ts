import path from "node:path";
import { app } from "electron";
import { createDb, runMigrations, type DB } from "@main/db/client";

let db: DB | undefined;

export function initDb(): DB {
  if (db) return db;
  const dbPath = path.join(app.getPath("userData"), "marginalia.db");
  // 开发期迁移目录在源码树；打包期目录解析放到打包里程碑处理。
  const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(__dirname, "db/migrations");
  db = createDb(dbPath);
  runMigrations(db, migrationsFolder);
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}
