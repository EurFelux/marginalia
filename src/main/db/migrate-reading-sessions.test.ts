import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";

const MIGRATIONS = path.resolve(__dirname, "migrations");
const LEGACY_LAST_MIGRATION = "20260616082526_luxuriant_centennial";

function copyLegacyMigrations(destination: string): void {
  for (const entry of fs.readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name <= LEGACY_LAST_MIGRATION) {
      fs.cpSync(path.join(MIGRATIONS, entry.name), path.join(destination, entry.name), {
        recursive: true,
      });
    }
  }
}

describe("reading session migrations", () => {
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
});
