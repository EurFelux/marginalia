import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations, type RunMigrationsHooks } from "@main/db/client";

const MIGRATIONS = path.resolve(__dirname, "migrations");
const LEGACY_LAST_MIGRATION = "20260616082526_luxuriant_centennial";

function copyLegacyMigrations(destination: string, lastMigration = LEGACY_LAST_MIGRATION): void {
  for (const entry of fs.readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name <= lastMigration) {
      fs.cpSync(path.join(MIGRATIONS, entry.name), path.join(destination, entry.name), {
        recursive: true,
      });
    }
  }
}

function makeDiskDatabase(lastMigration = LEGACY_LAST_MIGRATION): {
  databaseFile: string;
  legacyMigrations: string;
  cleanup: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-legacy-recovery-"));
  const legacyMigrations = path.join(directory, "legacy-migrations");
  fs.mkdirSync(legacyMigrations);
  copyLegacyMigrations(legacyMigrations, lastMigration);
  return {
    databaseFile: path.join(directory, "marginalia.db"),
    legacyMigrations,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function seedLegacyBook(databaseFile: string, legacyMigrations: string): void {
  const db = createDb(databaseFile);
  try {
    runMigrations(db, legacyMigrations);
    db.run(sql`
      INSERT INTO books (
        id, title, author, format, has_text_layer, added_at, position, parser_version, is_finished
      ) VALUES ('legacy-book', 'Legacy book', 'Legacy author', 'epub', 1, 1, 0, 0, 1)
    `);
    db.run(sql`
      INSERT INTO conversations (id, book_id, title, created_at, updated_at)
      VALUES ('legacy-conversation', 'legacy-book', 'Conversation', 7, 8)
    `);
    db.run(sql`
      INSERT INTO messages (id, conversation_id, role, parts, status, seq, created_at)
      VALUES ('legacy-message', 'legacy-conversation', 'user', '[{"type":"text","text":"Hello"}]', 'complete', 0, 9)
    `);
    db.run(sql`
      INSERT INTO reading_daily (id, book_id, day, seconds)
      VALUES
        ('legacy-daily-1', 'legacy-book', '2026-07-01', 42),
        ('legacy-daily-2', 'legacy-book', '2026-07-02', 24)
    `);
  } finally {
    db.$client.close();
  }
}

function withDatabase<T>(databaseFile: string, fn: (db: ReturnType<typeof createDb>) => T): T {
  const db = createDb(databaseFile);
  try {
    return fn(db);
  } finally {
    db.$client.close();
  }
}

function expectLegacyRecovery(databaseFile: string): void {
  withDatabase(databaseFile, (db) => {
    const sessions = db.all<{
      id: string;
      started_at: number;
      completed_at: number | null;
    }>(
      sql`SELECT id, started_at, completed_at FROM reading_sessions WHERE book_id = 'legacy-book'`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      started_at: 9,
      completed_at: Temporal.PlainDate.from("2026-07-02").toZonedDateTime("UTC").epochMilliseconds,
    });
    expect(
      db.all<{ reading_session_id: string | null }>(sql`
        SELECT reading_session_id FROM reading_daily WHERE book_id = 'legacy-book' ORDER BY id
      `),
    ).toEqual([{ reading_session_id: sessions[0].id }, { reading_session_id: sessions[0].id }]);
    expect(
      db.get(sql`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name = '__marginalia_legacy_reading_sessions'
      `),
    ).toBeUndefined();

    runMigrations(db, MIGRATIONS);
    expect(db.all(sql`SELECT id FROM reading_sessions WHERE book_id = 'legacy-book'`)).toHaveLength(
      1,
    );
  });
}

describe("reading session migrations", () => {
  it("stages an active session from a pre-is_finished database with a real reading trace", () => {
    const fixture = makeDiskDatabase("20260608155900_clear_dreadnoughts");
    try {
      withDatabase(fixture.databaseFile, (db) => {
        runMigrations(db, fixture.legacyMigrations);
        db.run(sql`
          INSERT INTO books (id, title, author, format, has_text_layer, added_at, position, parser_version)
          VALUES ('legacy-book', 'Legacy book', 'Legacy author', 'epub', 1, 4, 0, 0)
        `);
        db.run(sql`
          INSERT INTO books (id, title, author, format, has_text_layer, added_at, position, parser_version)
          VALUES ('unread-book', 'Unread book', 'Legacy author', 'epub', 1, 5, 0, 0)
        `);
        db.run(sql`
          INSERT INTO assistants (id, name, created_at)
          VALUES ('legacy-assistant', 'Legacy assistant', 1)
        `);
        db.run(sql`
          INSERT INTO conversations (id, book_id, assistant_id, title, created_at, updated_at)
          VALUES ('legacy-conversation', 'legacy-book', 'legacy-assistant', 'Conversation', 7, 8)
        `);
        db.run(sql`
          INSERT INTO messages (id, conversation_id, role, parts, status, seq, created_at)
          VALUES ('legacy-message', 'legacy-conversation', 'user', '[{"type":"text","text":"Hello"}]', 'complete', 0, 9)
        `);
      });

      withDatabase(fixture.databaseFile, (db) => runMigrations(db, MIGRATIONS));
      withDatabase(fixture.databaseFile, (db) => {
        expect(
          db.get(sql`
            SELECT started_at, completed_at FROM reading_sessions WHERE book_id = 'legacy-book'
          `),
        ).toEqual({ started_at: 9, completed_at: null });
        expect(
          db.get(sql`SELECT id FROM reading_sessions WHERE book_id = 'unread-book'`),
        ).toBeUndefined();
        expect(
          db.get(
            sql`SELECT name FROM sqlite_master WHERE name = '__marginalia_legacy_reading_sessions'`,
          ),
        ).toBeUndefined();
        runMigrations(db, MIGRATIONS);
        expect(
          db.all(sql`SELECT id FROM reading_sessions WHERE book_id = 'legacy-book'`),
        ).toHaveLength(1);
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("upgrades an is_finished database from before reading_daily existed", () => {
    const fixture = makeDiskDatabase("20260608172021_slippery_gorilla_man");
    try {
      withDatabase(fixture.databaseFile, (db) => {
        runMigrations(db, fixture.legacyMigrations);
        db.run(sql`
          INSERT INTO books (
            id, title, author, format, has_text_layer, added_at, position, parser_version, is_finished
          ) VALUES ('legacy-book', 'Legacy book', 'Legacy author', 'epub', 1, 4, 0, 0, 1)
        `);
        db.run(sql`
          INSERT INTO assistants (id, name, created_at)
          VALUES ('legacy-assistant', 'Legacy assistant', 1)
        `);
        db.run(sql`
          INSERT INTO conversations (id, book_id, assistant_id, title, created_at, updated_at)
          VALUES ('legacy-conversation', 'legacy-book', 'legacy-assistant', 'Conversation', 7, 8)
        `);
        db.run(sql`
          INSERT INTO messages (id, conversation_id, role, parts, status, seq, created_at)
          VALUES ('legacy-message', 'legacy-conversation', 'user', '[{"type":"text","text":"Hello"}]', 'complete', 0, 9)
        `);
      });

      withDatabase(fixture.databaseFile, (db) => runMigrations(db, MIGRATIONS));
      withDatabase(fixture.databaseFile, (db) => {
        expect(
          db.get(sql`
            SELECT started_at, completed_at FROM reading_sessions WHERE book_id = 'legacy-book'
          `),
        ).toEqual({ started_at: 9, completed_at: 9 });
        expect(
          db.get(sql`SELECT name FROM sqlite_master WHERE name = 'reading_daily'`),
        ).toBeDefined();
        expect(
          db.get(
            sql`SELECT name FROM sqlite_master WHERE name = '__marginalia_legacy_reading_sessions'`,
          ),
        ).toBeUndefined();
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("upgrades a reading_daily database from before book_notes existed", () => {
    const fixture = makeDiskDatabase("20260609051433_grey_gertrude_yorkes");
    try {
      withDatabase(fixture.databaseFile, (db) => {
        runMigrations(db, fixture.legacyMigrations);
        db.run(sql`
          INSERT INTO books (
            id, title, author, format, has_text_layer, added_at, position, parser_version, is_finished
          ) VALUES ('legacy-book', 'Legacy book', 'Legacy author', 'epub', 1, 4, 0, 0, 1)
        `);
        db.run(sql`
          INSERT INTO reading_daily (id, book_id, day, seconds)
          VALUES ('legacy-daily', 'legacy-book', '2026-07-01', 42)
        `);
      });

      withDatabase(fixture.databaseFile, (db) => runMigrations(db, MIGRATIONS));
      withDatabase(fixture.databaseFile, (db) => {
        const session = db.get<{ id: string; started_at: number; completed_at: number }>(sql`
          SELECT id, started_at, completed_at FROM reading_sessions WHERE book_id = 'legacy-book'
        `);
        expect(session).toMatchObject({
          started_at:
            Temporal.PlainDate.from("2026-07-01").toZonedDateTime("UTC").epochMilliseconds,
          completed_at:
            Temporal.PlainDate.from("2026-07-01").toZonedDateTime("UTC").epochMilliseconds,
        });
        expect(
          db.get(sql`SELECT reading_session_id FROM reading_daily WHERE id = 'legacy-daily'`),
        ).toEqual({ reading_session_id: session?.id });
        expect(
          db.get(
            sql`SELECT name FROM sqlite_master WHERE name = '__marginalia_legacy_reading_sessions'`,
          ),
        ).toBeUndefined();
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves a populated legacy library while deriving reading state", () => {
    const legacyMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-legacy-"));
    try {
      copyLegacyMigrations(legacyMigrations);
      const db = createDb(":memory:");
      runMigrations(db, legacyMigrations);

      db.run(sql`
        INSERT INTO books (
          id, title, author, format, has_text_layer, added_at, position, parser_version, is_finished
        ) VALUES ('legacy-book', 'Legacy book', 'Legacy author', 'epub', 1, 1, 0, 0, 1)
      `);
      db.run(sql`
        INSERT INTO progress (book_id, locator, percent, updated_at)
        VALUES ('legacy-book', 'epubcfi(/6/2)', 0.5, 2)
      `);
      db.run(sql`
        INSERT INTO annotations (
          id, book_id, style, note, selected_text, locator_range, created_at, updated_at
        ) VALUES ('legacy-annotation', 'legacy-book', 'yellow', 'Note', 'Selected text', 'range', 3, 4)
      `);
      db.run(sql`
        INSERT INTO book_notes (id, book_id, content, created_at, updated_at)
        VALUES ('legacy-note', 'legacy-book', 'Book note', 5, 6)
      `);
      db.run(sql`
        INSERT INTO conversations (id, book_id, title, created_at, updated_at)
        VALUES ('legacy-conversation', 'legacy-book', 'Conversation', 7, 8)
      `);
      db.run(sql`
        INSERT INTO messages (id, conversation_id, role, parts, status, seq, created_at)
        VALUES ('legacy-message', 'legacy-conversation', 'user', '[{"type":"text","text":"Hello"}]', 'complete', 0, 9)
      `);
      db.run(sql`
        INSERT INTO reading_daily (id, book_id, day, seconds)
        VALUES ('legacy-daily', 'legacy-book', '2026-07-01', 42)
      `);

      runMigrations(db, MIGRATIONS);

      const legacySession = db.get<{
        id: string;
        book_id: string;
        started_at: number;
        completed_at: number | null;
      }>(sql`
        SELECT id, book_id, started_at, completed_at FROM reading_sessions WHERE book_id = 'legacy-book'
      `);
      expect(legacySession).toMatchObject({
        book_id: "legacy-book",
        started_at: 9,
        completed_at:
          Temporal.PlainDate.from("2026-07-01").toZonedDateTime("UTC").epochMilliseconds,
      });
      expect(legacySession?.id).toEqual(expect.any(String));
      expect(db.get(sql`SELECT locator FROM progress WHERE book_id = 'legacy-book'`)).toEqual({
        locator: "epubcfi(/6/2)",
      });
      expect(
        db.get(sql`SELECT selected_text FROM annotations WHERE id = 'legacy-annotation'`),
      ).toEqual({
        selected_text: "Selected text",
      });
      expect(db.get(sql`SELECT content FROM book_notes WHERE id = 'legacy-note'`)).toEqual({
        content: "Book note",
      });
      expect(db.get(sql`SELECT id FROM conversations WHERE id = 'legacy-conversation'`)).toEqual({
        id: "legacy-conversation",
      });
      expect(db.get(sql`SELECT id FROM messages WHERE id = 'legacy-message'`)).toEqual({
        id: "legacy-message",
      });
      expect(
        db.get(sql`
          SELECT book_id, reading_session_id, seconds
          FROM reading_daily WHERE id = 'legacy-daily'
        `),
      ).toEqual({ book_id: "legacy-book", reading_session_id: legacySession?.id, seconds: 42 });
      expect(
        db.all<{ name: string }>(sql`PRAGMA table_info(books)`).map((column) => column.name),
      ).not.toContain("is_finished");

      runMigrations(db, MIGRATIONS);
      expect(
        db.all(sql`SELECT id FROM reading_sessions WHERE book_id = 'legacy-book'`),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(legacyMigrations, { recursive: true, force: true });
    }
  });

  it("does not leave legacy staging state for a fresh empty database", () => {
    const db = createDb(":memory:");

    runMigrations(db, MIGRATIONS);

    expect(
      db.get(sql`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name = '__marginalia_legacy_reading_sessions'
      `),
    ).toBeUndefined();
  });

  it.each([
    [
      "after staging and before DDL",
      false,
      {
        afterLegacyReadingSessionsStaged: () => {
          throw new Error("crash");
        },
      },
    ],
    [
      "after DDL and before post-apply",
      true,
      {
        afterMigrationDdl: () => {
          throw new Error("crash");
        },
      },
    ],
    [
      "after session insertion within post-apply",
      true,
      {
        afterLegacyReadingSessionInsert: () => {
          throw new Error("crash");
        },
      },
    ],
  ] as const)(
    "recovers a disk database interrupted %s",
    (_point, ddlApplied: boolean, hooks: RunMigrationsHooks) => {
      const fixture = makeDiskDatabase();
      try {
        seedLegacyBook(fixture.databaseFile, fixture.legacyMigrations);

        expect(() =>
          withDatabase(fixture.databaseFile, (db) => runMigrations(db, MIGRATIONS, hooks)),
        ).toThrow("crash");

        withDatabase(fixture.databaseFile, (db) => {
          expect(
            db.get(sql`
            SELECT name FROM sqlite_master WHERE type = 'table'
              AND name = '__marginalia_legacy_reading_sessions'
          `),
          ).toBeDefined();
          const bookColumns = db
            .all<{ name: string }>(sql`PRAGMA table_info(books)`)
            .map((column) => column.name);
          expect(bookColumns.includes("is_finished")).toBe(!ddlApplied);
          const hasReadingSessions = Boolean(
            db.get(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reading_sessions'`,
            ),
          );
          expect(hasReadingSessions).toBe(ddlApplied);
          if (hasReadingSessions) {
            expect(
              db.all(sql`SELECT id FROM reading_sessions WHERE book_id = 'legacy-book'`),
            ).toHaveLength(0);
          }
        });

        withDatabase(fixture.databaseFile, (db) => runMigrations(db, MIGRATIONS));
        expectLegacyRecovery(fixture.databaseFile);
      } finally {
        fixture.cleanup();
      }
    },
  );
});
