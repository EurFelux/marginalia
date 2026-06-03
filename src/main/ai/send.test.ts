// src/main/ai/send.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { eq } from "drizzle-orm";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { listConversationsByBook } from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { buildChips } from "@main/ai/chips";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import { runSend, type SendDeps, type SendInput } from "@main/ai/send";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// V3 流分片形状（与 summary.test.ts 的 genModel 同源）。usage 嵌套、finishReason 为对象。
const USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const finishChunk = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage: USAGE,
});

function textStreamModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          finishChunk("stop"),
        ],
      }),
    }),
  });
}

function capturingStreamModel(text: string, capture: { prompt?: string }) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      capture.prompt = JSON.stringify(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

// 两步 agent mock：第1步发 getToc 工具调用，第2步发文本。
function tocThenTextModel(text: string) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call" as const, toolCallId: "c1", toolName: "getToc", input: "{}" },
              finishChunk("tool-calls"),
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

function setup(model: ResolvedModel) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SendDeps = { db, loadBytes, resolveModel: () => model };
  return { db, book, ch1, deps };
}

function input(bookId: string, chapterId: string, over: Partial<SendInput> = {}): SendInput {
  return {
    bookId,
    currentChapterId: chapterId,
    activeConversationId: null,
    chips: buildChips({ selection: "the cat", paragraphCurrent: "the cat sat on the mat" }),
    userText: "what does this mean?",
    ...over,
  };
}

describe("runSend", () => {
  it("returns an error and creates nothing when no model is configured", () => {
    const { db, book, ch1, deps } = setup({ ok: false, reason: "not configured" });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(false);
    expect(listConversationsByBook(db, book.id)).toEqual([]);
  });

  it("persists the user message with a chip snapshot and the streamed assistant message", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: textStreamModel("It means hello."),
      modelId: "mock",
    });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const msgs = listMessages(db, r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const user = msgs[0];
    expect(user.parts).toEqual([{ type: "text", text: "what does this mean?" }]);
    expect(user.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection", "paragraph"]);
    expect(user.metadata?.model).toBe("mock");
    const assistantText = msgs[1].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(assistantText).toContain("It means hello.");
    expect(r.created).toBe(true);
  });

  it("runs the tool-calling agent loop and persists tool parts in the assistant message", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: tocThenTextModel("Done."),
      modelId: "mock",
    });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant")!;
    const partTypes = assistant.parts.map((p) => p.type);
    expect(partTypes.some((t) => t.startsWith("tool-") || t === "dynamic-tool")).toBe(true);
    expect(partTypes).toContain("text");
    expect(JSON.stringify(assistant.parts)).toContain("Chapter One");
  });

  it("does not persist an assistant message when streaming errors", async () => {
    const failModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("stream boom");
      },
    });
    const { db, book, ch1, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const roles = listMessages(db, r.conversationId).map((m) => m.role);
    expect(roles).toEqual(["user"]);
  });

  it("injects a ready chapter summary into the prompt", async () => {
    const capture: { prompt?: string } = {};
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: capturingStreamModel("ok", capture),
      modelId: "mock",
    });
    db.update(chapters)
      .set({ summary: "CHAPTER-SUMMARY-XYZ" })
      .where(eq(chapters.id, ch1.id))
      .run();
    const r = runSend(deps, input(book.id, ch1.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    expect(capture.prompt).toContain("CHAPTER-SUMMARY-XYZ"); // 摘要进了模型输入
  });

  it("returns an error without writing when the chapter belongs to a different book", () => {
    const { db, book, deps } = setup({ ok: true, model: textStreamModel("x"), modelId: "mock" });
    // 另一本书的章节：chapters.id 合法（FK 不报错）但不属于 book
    const otherBook = importBook(db, {
      bytes: makeFixtureEpub({ identifier: "urn:uuid:other-book" }),
      filePath: "/other.epub",
    });
    const otherCh = resolveChapterByHref(db, otherBook.id, "OEBPS/ch1.xhtml")!;
    const r = runSend(deps, input(book.id, otherCh.id));
    expect(r.ok).toBe(false);
    expect(listConversationsByBook(db, book.id)).toEqual([]);
    expect(listConversationsByBook(db, otherBook.id)).toEqual([]);
  });

  it("forwards a non-aborted signal without breaking the normal persist path", async () => {
    const controller = new AbortController();
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: textStreamModel("hello"),
      modelId: "mock",
    });
    const r = runSend(deps, input(book.id, ch1.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    // 正常路径：user + assistant 两条都落库
    expect(listMessages(db, r.conversationId)).toHaveLength(2);
  });

  it("omits the paragraph chip from the snapshot when it duplicates the conversation's last", async () => {
    const { db, book, ch1, deps } = setup({
      ok: true,
      model: textStreamModel("ok"),
      modelId: "mock",
    });
    const first = runSend(
      deps,
      input(book.id, ch1.id, {
        chips: buildChips({ selection: "s1", paragraphCurrent: "dup para" }),
        userText: "q1",
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.finished;

    const second = runSend(
      deps,
      input(book.id, ch1.id, {
        activeConversationId: first.conversationId,
        chips: buildChips({ selection: "s2", paragraphCurrent: "dup para" }),
        userText: "q2",
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.finished;

    const userMsgs = listMessages(db, first.conversationId).filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection"]);
  });
});
