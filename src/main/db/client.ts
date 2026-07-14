import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { v7 as uuidv7 } from "uuid";
import * as schema from "@main/db/schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: InstanceType<typeof Database> };

const LEGACY_READING_SESSIONS_STAGING = "__marginalia_legacy_reading_sessions";

function tableExists(db: DB, table: string): boolean {
  return Boolean(
    db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function columnExists(db: DB, table: string, column: string): boolean {
  return db.$client
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => (row as { name: string }).name === column);
}

interface LegacyReadingSessionCandidate {
  bookId: string;
  isFinished: number;
  firstMessageAt: number | null;
  fallbackStartedAt: number | null;
  lastEvidenceAt: number | null;
}

function stageLegacyReadingSessions(db: DB): void {
  if (tableExists(db, LEGACY_READING_SESSIONS_STAGING)) return;
  if (!columnExists(db, "books", "is_finished")) return;

  const candidates = db.$client
    .prepare(`
      SELECT
        books.id AS bookId,
        books.is_finished AS isFinished,
        (
          SELECT MIN(messages.created_at)
          FROM messages
          INNER JOIN conversations ON conversations.id = messages.conversation_id
          WHERE conversations.book_id = books.id
        ) AS firstMessageAt,
        (
          SELECT MIN(timestamp) FROM (
            SELECT progress.updated_at AS timestamp FROM progress WHERE progress.book_id = books.id
            UNION ALL SELECT annotations.created_at FROM annotations WHERE annotations.book_id = books.id
            UNION ALL SELECT annotations.updated_at FROM annotations WHERE annotations.book_id = books.id
            UNION ALL SELECT book_notes.created_at FROM book_notes WHERE book_notes.book_id = books.id
            UNION ALL SELECT book_notes.updated_at FROM book_notes WHERE book_notes.book_id = books.id
            UNION ALL SELECT conversations.created_at FROM conversations WHERE conversations.book_id = books.id
            UNION ALL SELECT conversations.updated_at FROM conversations WHERE conversations.book_id = books.id
            UNION ALL SELECT CAST(strftime('%s', reading_daily.day) AS INTEGER) * 1000 FROM reading_daily WHERE reading_daily.book_id = books.id
          )
        ) AS fallbackStartedAt,
        (
          SELECT MAX(timestamp) FROM (
            SELECT progress.updated_at AS timestamp FROM progress WHERE progress.book_id = books.id
            UNION ALL SELECT annotations.created_at FROM annotations WHERE annotations.book_id = books.id
            UNION ALL SELECT annotations.updated_at FROM annotations WHERE annotations.book_id = books.id
            UNION ALL SELECT book_notes.created_at FROM book_notes WHERE book_notes.book_id = books.id
            UNION ALL SELECT book_notes.updated_at FROM book_notes WHERE book_notes.book_id = books.id
            UNION ALL SELECT conversations.created_at FROM conversations WHERE conversations.book_id = books.id
            UNION ALL SELECT conversations.updated_at FROM conversations WHERE conversations.book_id = books.id
            UNION ALL SELECT messages.created_at FROM messages INNER JOIN conversations ON conversations.id = messages.conversation_id WHERE conversations.book_id = books.id
            UNION ALL SELECT CAST(strftime('%s', reading_daily.day) AS INTEGER) * 1000 FROM reading_daily WHERE reading_daily.book_id = books.id
          )
        ) AS lastEvidenceAt
      FROM books
      WHERE EXISTS (SELECT 1 FROM progress WHERE progress.book_id = books.id)
        OR EXISTS (SELECT 1 FROM annotations WHERE annotations.book_id = books.id)
        OR EXISTS (SELECT 1 FROM book_notes WHERE book_notes.book_id = books.id)
        OR EXISTS (SELECT 1 FROM conversations WHERE conversations.book_id = books.id)
        OR EXISTS (SELECT 1 FROM reading_daily WHERE reading_daily.book_id = books.id)
    `)
    .all() as LegacyReadingSessionCandidate[];
  if (candidates.length === 0) return;

  const create = db.$client.prepare(`
    CREATE TABLE ${LEGACY_READING_SESSIONS_STAGING} (
      book_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      is_finished INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  db.$client.transaction(() => {
    create.run();
    const insert = db.$client.prepare(`
      INSERT INTO ${LEGACY_READING_SESSIONS_STAGING}
        (book_id, session_id, is_finished, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const candidate of candidates) {
      const startedAt = candidate.firstMessageAt ?? candidate.fallbackStartedAt;
      if (startedAt == null) continue;
      insert.run(
        candidate.bookId,
        uuidv7(),
        candidate.isFinished,
        startedAt,
        candidate.isFinished ? Math.max(startedAt, candidate.lastEvidenceAt ?? startedAt) : null,
      );
    }
  })();
}

function applyStagedLegacyReadingSessions(db: DB): void {
  if (!tableExists(db, LEGACY_READING_SESSIONS_STAGING)) return;
  if (
    !tableExists(db, "reading_sessions") ||
    !columnExists(db, "reading_daily", "reading_session_id")
  ) {
    return;
  }
  db.$client.transaction(() => {
    db.$client
      .prepare(`
      INSERT INTO reading_sessions (id, book_id, started_at, completed_at)
      SELECT staged.session_id, staged.book_id, staged.started_at, staged.completed_at
      FROM ${LEGACY_READING_SESSIONS_STAGING} AS staged
      WHERE NOT EXISTS (SELECT 1 FROM reading_sessions WHERE id = staged.session_id)
    `)
      .run();
    db.$client
      .prepare(`
      UPDATE reading_daily
      SET reading_session_id = (
        SELECT staged.session_id
        FROM ${LEGACY_READING_SESSIONS_STAGING} AS staged
        WHERE staged.book_id = reading_daily.book_id
      )
      WHERE reading_session_id IS NULL
        AND EXISTS (
          SELECT 1 FROM ${LEGACY_READING_SESSIONS_STAGING} AS staged
          WHERE staged.book_id = reading_daily.book_id
        )
    `)
      .run();
    db.$client.prepare(`DROP TABLE ${LEGACY_READING_SESSIONS_STAGING}`).run();
  })();
}

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
  stageLegacyReadingSessions(db);
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
  applyStagedLegacyReadingSessions(db);
}
