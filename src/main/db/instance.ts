import path from "node:path";
import { app } from "electron";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { ensureBuiltinProviders } from "@main/providers/default-providers";

let db: DB | undefined;

export function initDb(): DB {
  if (db) return db;
  const dbPath = path.join(app.getPath("userData"), "marginalia.db");
  // 开发期迁移目录在源码树；生产期由 forge.config.ts 的 packagerConfig.extraResource
  // 复制到 resources/migrations，经 process.resourcesPath 读取（asar 内取不到迁移 SQL）。
  const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(process.resourcesPath, "migrations");
  const candidate = createDb(dbPath);
  runMigrations(candidate, migrationsFolder);
  ensureBuiltinProviders(candidate); // 补齐缺失的内置 provider（OpenAI/Anthropic/Gemini）
  db = candidate;
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}

/** app 自有书籍副本根目录（Electron glue）。纯函数层通过此值注入 booksDir。 */
export function getBooksDir(): string {
  return path.join(app.getPath("userData"), "books");
}
