// src/main/chat/messages.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { assistants, books, conversations } from "@main/db/schema";
import {
  appendMessage,
  getMessage,
  getLastParagraphContent,
  isLastTurnIncomplete,
  listMessages,
  listMessagesAfterSeq,
  resetUserTurnForResend,
} from "@main/chat/messages";
import { buildChips, dedupeParagraph } from "@main/ai/chips";
import { createConversation } from "@main/chat/conversations";
import { importBook } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedAssistant(db: ReturnType<typeof freshDb>): string {
  return db.insert(assistants).values({ name: "Test" }).returning().get().id;
}

function seedConversation(db: ReturnType<typeof freshDb>): string {
  db.insert(books).values({ id: "book-1" }).run();
  const row = db
    .insert(conversations)
    .values({ bookId: "book-1", assistantId: seedAssistant(db) })
    .returning()
    .get();
  return row.id;
}

describe("appendMessage / listMessages", () => {
  it("assigns monotonically increasing seq starting at 0", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const m0 = appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const m1 = appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    const all = listMessages(db, cid);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(all.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("persists metadata.contextChips and returns it via listMessages", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "what is this?" }],
      metadata: {
        contextChips: [{ id: "selection", content: "the cat", tokenCount: 2 }],
      },
    });
    const [msg] = listMessages(db, cid);
    expect(msg.metadata?.contextChips?.[0]).toEqual({
      id: "selection",
      content: "the cat",
      tokenCount: 2,
    });
  });

  it("bumps conversations.updatedAt to a fresh timestamp on append", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    db.update(conversations).set({ updatedAt: 1 }).where(eq(conversations.id, cid)).run();
    const t0 = Date.now();
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "x" }],
    });
    const after = db.select().from(conversations).where(eq(conversations.id, cid)).get()!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(t0);
  });

  it("keeps seq independent per conversation", () => {
    const db = freshDb();
    db.insert(books).values({ id: "book-1" }).run();
    const assistantId = seedAssistant(db);
    const a = db.insert(conversations).values({ bookId: "book-1", assistantId }).returning().get();
    const b = db.insert(conversations).values({ bookId: "book-1", assistantId }).returning().get();
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "a0" }],
    });
    appendMessage(db, {
      conversationId: b.id,
      role: "user",
      parts: [{ type: "text", text: "b0" }],
    });
    appendMessage(db, {
      conversationId: a.id,
      role: "user",
      parts: [{ type: "text", text: "a1" }],
    });
    expect(listMessages(db, a.id).map((m) => m.seq)).toEqual([0, 1]);
    expect(listMessages(db, b.id).map((m) => m.seq)).toEqual([0]);
  });

  it("defaults status to 'complete' when not provided", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, { conversationId: cid, role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(listMessages(db, cid)[0].status).toBe("complete");
  });

  it("persists an explicit terminal status and error metadata", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [],
      status: "error",
      metadata: { error: { name: "AI_APICallError", message: "quota exceeded" } },
    });
    const [msg] = listMessages(db, cid);
    expect(msg.status).toBe("error");
    expect(msg.metadata?.error).toEqual({ name: "AI_APICallError", message: "quota exceeded" });
  });
});

describe("getLastParagraphContent", () => {
  it("returns null when no user message carries a paragraph chip", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "no chips" }],
    });
    expect(getLastParagraphContent(db, cid)).toBeNull();
  });

  it("returns the most recently inserted paragraph content, skipping turns without one", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "first" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para A", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
    });
    // 后一轮段落被去重（无 paragraph chip），应回退到 para A
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "second" }],
      metadata: { contextChips: [{ id: "selection", content: "sel", tokenCount: 1 }] },
    });
    expect(getLastParagraphContent(db, cid)).toBe("para A");
  });

  it("returns the higher-seq paragraph when multiple user turns carry one", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "a" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para A", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "b" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para B", tokenCount: 1 }] },
    });
    expect(getLastParagraphContent(db, cid)).toBe("para B");
  });

  it("dedupes a freshly built paragraph against the stored snapshot (format round-trip)", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const input = { selection: "sel", paragraphCurrent: "shared para" };
    const built = buildChips(input);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "q" }],
      // 持久化快照：Chip → {id, content, tokenCount}
      metadata: {
        contextChips: built.map((c) => ({
          id: c.id,
          content: c.content,
          tokenCount: c.tokenCount,
        })),
      },
    });
    const deduped = dedupeParagraph(buildChips(input), getLastParagraphContent(db, cid));
    expect(deduped.map((c) => c.id)).toEqual(["selection"]);
  });
});

describe("isLastTurnIncomplete", () => {
  it("returns false for an empty conversation", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    expect(isLastTurnIncomplete(db, cid)).toBe(false);
  });

  it("returns true when the last message is a user turn (crash before assistant reply)", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, { conversationId: cid, role: "user", parts: [{ type: "text", text: "q" }] });
    expect(isLastTurnIncomplete(db, cid)).toBe(true);
  });

  it("returns false when an assistant reply follows the user turn", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, { conversationId: cid, role: "user", parts: [{ type: "text", text: "q" }] });
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      status: "complete",
    });
    expect(isLastTurnIncomplete(db, cid)).toBe(false);
  });
});

describe("listMessagesAfterSeq", () => {
  function seedFourMessages() {
    const db = freshDb();
    const cid = seedConversation(db);
    for (let i = 0; i < 4; i++) {
      appendMessage(db, {
        conversationId: cid,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `m${i}` }],
      });
    }
    return { db, conversationId: cid };
  }

  it("returns all messages when afterSeq is null", () => {
    const { db, conversationId } = seedFourMessages();
    expect(listMessagesAfterSeq(db, conversationId, null).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns only the tail with seq > afterSeq", () => {
    const { db, conversationId } = seedFourMessages();
    expect(listMessagesAfterSeq(db, conversationId, 1).map((m) => m.seq)).toEqual([2, 3]);
  });

  it("returns an empty array when afterSeq is at or past the last seq", () => {
    const { db, conversationId } = seedFourMessages();
    expect(listMessagesAfterSeq(db, conversationId, 3)).toEqual([]);
  });
});

function freshConvoDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  // book.id 是 epub 自然键；建会话需有效 bookId
  return importBook(db, { bytes: makeFixtureEpub() }).then((book) => ({
    db,
    convoId: createConversation(db, { bookId: book.id }).id,
  }));
}

describe("getMessage", () => {
  it("returns the message dto or null", async () => {
    const { db: d, convoId } = await freshConvoDb();
    const m = appendMessage(d, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(getMessage(d, m.id)?.id).toBe(m.id);
    expect(getMessage(d, "nope")).toBeNull();
  });
});

describe("resetUserTurnForResend", () => {
  it("sets the user text, deletes everything after it, and returns its seq", async () => {
    const { db, convoId } = await freshConvoDb();
    const u = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "old" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u2" }],
    });
    const seq = resetUserTurnForResend(db, convoId, u.id, "new");
    expect(seq).toBe(u.seq);
    const left = listMessages(db, convoId);
    expect(left).toHaveLength(1);
    expect(left[0].parts).toEqual([{ type: "text", text: "new" }]);
  });

  it("preserves the user message metadata snapshot", async () => {
    const { db, convoId } = await freshConvoDb();
    const u = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "q" }],
      metadata: { contextChips: [{ id: "selection", content: "sel", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
    });
    resetUserTurnForResend(db, convoId, u.id, "edited");
    expect(getMessage(db, u.id)?.metadata?.contextChips).toEqual([
      { id: "selection", content: "sel", tokenCount: 1 },
    ]);
  });

  it("resets the rolling summary when truncating into or before the summarized boundary", async () => {
    const { db, convoId } = await freshConvoDb();
    const u0 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u0" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a0" }],
    });
    db.update(conversations)
      .set({ contextSummary: "S", summarizedThroughSeq: u0.seq + 1 })
      .where(eq(conversations.id, convoId))
      .run();
    resetUserTurnForResend(db, convoId, u0.id, "u0"); // S(seq+1) >= u0.seq → reset
    const c = db
      .select({ s: conversations.summarizedThroughSeq, sum: conversations.contextSummary })
      .from(conversations)
      .where(eq(conversations.id, convoId))
      .get();
    expect(c?.s).toBeNull();
    expect(c?.sum).toBeNull();
  });

  it("keeps the rolling summary when the boundary is older than the truncation point", async () => {
    const { db, convoId } = await freshConvoDb();
    const u0 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u0" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a0" }],
    });
    const u1 = appendMessage(db, {
      conversationId: convoId,
      role: "user",
      parts: [{ type: "text", text: "u1" }],
    });
    appendMessage(db, {
      conversationId: convoId,
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
    });
    db.update(conversations)
      .set({ contextSummary: "S", summarizedThroughSeq: u0.seq })
      .where(eq(conversations.id, convoId))
      .run();
    resetUserTurnForResend(db, convoId, u1.id, "u1"); // boundary(u0.seq) < u1.seq → keep
    const c = db
      .select({ s: conversations.summarizedThroughSeq, sum: conversations.contextSummary })
      .from(conversations)
      .where(eq(conversations.id, convoId))
      .get();
    expect(c?.s).toBe(u0.seq);
    expect(c?.sum).toBe("S");
  });
});
