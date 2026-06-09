import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@main/db/schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: InstanceType<typeof Database> };

/** 打开（或新建）一个 SQLite 库，启用 WAL + 外键约束，返回 Drizzle 实例。filename 传 ":memory:" 用于测试。 */
export function createDb(filename: string): DB {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle({ client: sqlite, schema });
}

/**
 * 应用 drizzle-kit 生成的迁移。
 *
 * 在迁移期间临时关闭外键约束：drizzle 的 `migrate()` 把所有迁移语句包在一个
 * `BEGIN…COMMIT` 事务里跑，而 SQLite 的 `PRAGMA foreign_keys` 在事务内是 no-op，
 * 故 drizzle-kit 在表重建迁移里自带的 `PRAGMA foreign_keys=OFF` 形同虚设。表重建
 * （建新表→拷贝→`DROP` 旧表→改名）的 `DROP` 会触发隐式 DELETE，若此时 FK 仍开且有
 * 子表行引用旧表（如 `messages` → `conversations`），`DROP` 直接报
 * `SQLITE_CONSTRAINT_FOREIGNKEY`。在事务外先关 FK、迁移完再开即可——连接级 pragma
 * 跨越迁移事务持续生效；迁移保留同 id 行，整完后引用完整性自洽。
 */
export function runMigrations(db: DB, migrationsFolder: string): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}
