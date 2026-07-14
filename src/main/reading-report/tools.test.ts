import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { makeScannedPdf } from "@marginalia/pdf-parser/fixture";
import { createDb, runMigrations } from "@main/db/client";
import {
  annotations,
  bookNotes,
  books,
  chapters,
  conversations,
  messages,
  readingSessions,
} from "@main/db/schema";
import { importBook } from "@main/library/repository";
import { createReadingReportTools } from "@main/reading-report/tools";
import type { LoadBytes } from "@main/ai/tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const opts = { toolCallId: "test", messages: [] } as never;
const startedAt = Temporal.Instant.from("2026-07-01T00:00:00Z").epochMilliseconds;
const completedAt = Temporal.Instant.from("2026-07-10T00:00:00Z").epochMilliseconds;
const before = Temporal.Instant.from("2026-06-30T23:59:59Z").epochMilliseconds;
const inside = Temporal.Instant.from("2026-07-05T00:00:00Z").epochMilliseconds;
const after = Temporal.Instant.from("2026-07-10T00:00:01Z").epochMilliseconds;

async function setupEpub() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = await importBook(db, { bytes });
  db.insert(books).values({ id: "other-book" }).run();
  const otherChapter = db
    .insert(chapters)
    .values({ bookId: "other-book", href: "other.xhtml", title: "Other" })
    .returning()
    .get();
  const session = db
    .insert(readingSessions)
    .values({ bookId: book.id, startedAt, completedAt })
    .returning()
    .get();
  const previous = db
    .insert(readingSessions)
    .values({ bookId: book.id, startedAt: before - 10, completedAt: before, report: "# Earlier" })
    .returning()
    .get();
  const later = db
    .insert(readingSessions)
    .values({ bookId: book.id, startedAt: after, completedAt: after + 1, report: "# Later" })
    .returning()
    .get();
  const reportless = db
    .insert(readingSessions)
    .values({ bookId: book.id, startedAt: before - 20, completedAt: before - 11 })
    .returning()
    .get();
  const otherSession = db
    .insert(readingSessions)
    .values({
      bookId: "other-book",
      startedAt: before - 20,
      completedAt: before,
      report: "# Other",
    })
    .returning()
    .get();
  db.insert(annotations)
    .values([
      {
        bookId: book.id,
        style: "yellow",
        note: "",
        selectedText: "inside",
        locatorRange: "a",
        createdAt: inside,
        updatedAt: inside,
      },
      {
        bookId: book.id,
        style: "yellow",
        note: "",
        selectedText: "outside",
        locatorRange: "b",
        createdAt: after,
        updatedAt: after,
      },
    ])
    .run();
  db.insert(bookNotes)
    .values([
      { bookId: book.id, content: "inside note", createdAt: inside, updatedAt: inside },
      { bookId: book.id, content: "outside note", createdAt: after, updatedAt: after },
    ])
    .run();
  const insideConversation = db
    .insert(conversations)
    .values({ bookId: book.id, title: "inside conversation" })
    .returning()
    .get();
  const outsideConversation = db
    .insert(conversations)
    .values({ bookId: book.id, title: "outside conversation" })
    .returning()
    .get();
  db.insert(messages)
    .values([
      {
        conversationId: insideConversation.id,
        role: "user",
        parts: [{ type: "text", text: "inside message" }],
        seq: 0,
        createdAt: inside,
      },
      {
        conversationId: outsideConversation.id,
        role: "user",
        parts: [{ type: "text", text: "outside message" }],
        seq: 0,
        createdAt: after,
      },
    ])
    .run();
  const loadBytes = vi.fn<LoadBytes>(async (bookId) => {
    if (bookId !== book.id) throw new Error("attempted to load another book");
    return bytes;
  });
  const tools = createReadingReportTools({ db, session, loadBytes, imageToolResults: false });
  return {
    db,
    book,
    session,
    previous,
    later,
    reportless,
    otherSession,
    otherChapter,
    loadBytes,
    tools,
  };
}

describe("createReadingReportTools", () => {
  it("keeps annotations, notes, and conversations inside the target session window", async () => {
    const { tools } = await setupEpub();
    const annotationsPage = (await tools.listAnnotations.execute!(
      { offset: 0, limit: 50 },
      opts,
    )) as { items: Array<{ selectedText: string }> };
    const notesPage = (await tools.listBookNotes.execute!({ offset: 0, limit: 50 }, opts)) as {
      items: Array<{ content: string }>;
    };
    const conversationsPage = (await tools.listConversations.execute!(
      { offset: 0, limit: 50 },
      opts,
    )) as { items: Array<{ title: string | null }> };
    expect(annotationsPage.items.map((item) => item.selectedText)).toEqual(["inside"]);
    expect(notesPage.items.map((item) => item.content)).toEqual(["inside note"]);
    expect(conversationsPage.items.map((item) => item.title)).toEqual(["inside conversation"]);
  });

  it("returns only previous report content from this book", async () => {
    const { tools, session, previous, later, reportless, otherSession } = await setupEpub();
    expect(await tools.getPreviousReadingReport.execute!({ sessionId: previous.id }, opts)).toEqual(
      expect.objectContaining({ id: previous.id, content: "# Earlier" }),
    );
    for (const sessionId of [session.id, later.id, otherSession.id, reportless.id]) {
      const out = (await tools.getPreviousReadingReport.execute!({ sessionId }, opts)) as {
        error?: string;
      };
      expect(out.error).toMatch(/previous reading session (not found|has no report)/);
    }
  });

  it("binds chapter reads to the target book", async () => {
    const { tools, otherChapter, loadBytes } = await setupEpub();
    const out = (await tools.readChapterText.execute!({ chapterId: otherChapter.id }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/not found/);
    expect(loadBytes).not.toHaveBeenCalled();
  });

  it("defaults list paging to 50 and caps the schema at 100", async () => {
    const { tools } = await setupEpub();
    const schema = tools.listAnnotations.inputSchema as {
      parse(input: unknown): { offset: number; limit: number };
      safeParse(input: unknown): { success: boolean };
    };
    expect(schema.parse({})).toEqual({ offset: 0, limit: 50 });
    expect(schema.parse({ offset: 0, limit: 100 })).toEqual({ offset: 0, limit: 100 });
    expect(schema.safeParse({ offset: 0, limit: 101 }).success).toBe(false);
  });
});

describe("PDF report tools", () => {
  it("keeps page reads bound to the target book and retains trace tools for scanned PDFs", async () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    const session = db
      .insert(readingSessions)
      .values({ bookId: book.id, startedAt, completedAt })
      .returning()
      .get();
    const loadBytes = vi.fn<LoadBytes>(async (bookId) => {
      if (bookId !== book.id) throw new Error("attempted to load another book");
      return bytes;
    });
    const tools = createReadingReportTools({ db, session, loadBytes, imageToolResults: true });
    if (!("readPage" in tools)) throw new Error("readPage missing");

    expect("listAnnotations" in tools).toBe(true);
    const out = (await tools.readPage.execute!({ page: 1, mode: "text" }, opts)) as {
      error?: string;
    };
    expect(out.error).toMatch(/scanned|text layer/);
    expect(loadBytes).toHaveBeenCalledWith(book.id);
  });
});
