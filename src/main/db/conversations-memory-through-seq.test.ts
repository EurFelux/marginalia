import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import { createConversation } from "@main/chat/conversations";
import { conversations } from "@main/db/schema";

const MIGRATIONS = path.resolve(__dirname, "migrations");

describe("conversations.memoryThroughSeq", () => {
  it("defaults to null and round-trips an update", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const convo = createConversation(db, { bookId: book.id });

    const before = db
      .select({ s: conversations.memoryThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, convo.id))
      .get();
    expect(before?.s ?? null).toBeNull();

    db.update(conversations)
      .set({ memoryThroughSeq: 7 })
      .where(eq(conversations.id, convo.id))
      .run();

    const after = db
      .select({ s: conversations.memoryThroughSeq })
      .from(conversations)
      .where(eq(conversations.id, convo.id))
      .get();
    expect(after?.s).toBe(7);
  });
});
