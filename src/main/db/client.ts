import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@main/db/schema";

export type DB = BetterSQLite3Database<typeof schema>;

/** 打开（或新建）一个 SQLite 库并返回 Drizzle 实例。filename 传 ":memory:" 用于测试。 */
export function createDb(filename: string): DB {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle({ client: sqlite, schema });
}

/** 应用 drizzle-kit 生成的迁移。 */
export function runMigrations(db: DB, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
