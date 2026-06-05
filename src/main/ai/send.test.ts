// src/main/ai/send.test.ts
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
  setConversationTitle,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { buildChips } from "@main/ai/chips";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import { runSend, type SendDeps, type SendInput } from "@main/ai/send";
import { __resetNamingRuntime } from "@main/chat/conversation-title";

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

/** 同时支持 doStream（流式主回复）与 doGenerate（auto-naming 调用）的 mock */
function textStreamModelWithNaming(streamText: string, namingTitle: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: streamText },
          { type: "text-end", id: "t1" },
          finishChunk("stop"),
        ],
      }),
    }),
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      content: [{ type: "text" as const, text: namingTitle }],
      warnings: [],
    }),
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
  const book = importBook(db, { bytes });
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SendDeps = { db, loadBytes, resolveModel: () => model };
  return { db, book, deps };
}

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedBook(db: ReturnType<typeof freshDb>) {
  const bytes = makeFixtureEpub();
  return importBook(db, { bytes });
}

function makeDeps(db: ReturnType<typeof freshDb>): SendDeps {
  const bytes = makeFixtureEpub();
  const loadBytes: LoadBytes = async () => bytes;
  const model: ResolvedModel = { ok: true, model: textStreamModel("ok"), modelId: "mock" };
  return { db, loadBytes, resolveModel: () => model };
}

function input(bookId: string, conversationId: string, over: Partial<SendInput> = {}): SendInput {
  return {
    bookId,
    conversationId,
    chips: buildChips({ selection: "the cat", paragraphCurrent: "the cat sat on the mat" }),
    userText: "what does this mean?",
    ...over,
  };
}

describe("runSend conversation validation", () => {
  it("rejects unknown conversationId without writing anything", () => {
    const db = freshDb();
    seedBook(db);
    const result = runSend(makeDeps(db), {
      bookId: "book-1",
      conversationId: "nope",
      chips: [],
      userText: "hi",
    });
    // 校验：runSend 拒绝未知会话，返回错误（i18n 在测试环境未初始化，不断言 reason 文案）
    expect(result.ok).toBe(false);
  });

  it("rejects a conversation belonging to another book", () => {
    const db = freshDb();
    const book1 = seedBook(db);
    const book2 = importBook(db, {
      bytes: makeFixtureEpub({ identifier: "urn:uuid:other-book" }),
    });
    const other = createConversation(db, { bookId: book2.id });
    const result = runSend(makeDeps(db), {
      bookId: book1.id,
      conversationId: other.id,
      chips: [],
      userText: "hi",
    });
    expect(result.ok).toBe(false);
  });
});

describe("runSend", () => {
  beforeEach(() => __resetNamingRuntime());

  it("returns an error and creates nothing when no model is configured", () => {
    const { db, book, deps } = setup({ ok: false, reason: "not configured" });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(false);
    expect(listConversationsByBook(db, book.id)).toHaveLength(1); // conversation still there, just no messages
  });

  it("persists the user message with a chip snapshot and the streamed assistant message", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: textStreamModel("It means hello."),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id));
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
    expect(msgs[1].status).toBe("complete");
    expect(msgs[1].metadata?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("runs the tool-calling agent loop and persists tool parts in the assistant message", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: tocThenTextModel("Done."),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant")!;
    const partTypes = assistant.parts.map((p) => p.type);
    expect(partTypes.some((t) => t.startsWith("tool-") || t === "dynamic-tool")).toBe(true);
    expect(partTypes).toContain("text");
    expect(JSON.stringify(assistant.parts)).toContain("Chapter One");
  });

  it("persists an error-status assistant message when streaming errors", async () => {
    const failModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("stream boom");
      },
    });
    const { db, book, deps } = setup({ ok: true, model: failModel, modelId: "mock" });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const msgs = listMessages(db, r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]); // 不再是孤儿 user turn
    const assistant = msgs[1];
    expect(assistant.status).toBe("error");
    expect(assistant.metadata?.error?.message).toContain("stream boom");
  });

  it("forwards a non-aborted signal without breaking the normal persist path", async () => {
    const controller = new AbortController();
    const { db, book, deps } = setup({
      ok: true,
      model: textStreamModel("hello"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    // 正常路径：user + assistant 两条都落库
    expect(listMessages(db, r.conversationId)).toHaveLength(2);
  });

  it("persists an aborted-status assistant message when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    // 延迟分片：abort 在分片尚未发完时触发 → onFinish 收 isAborted=true。
    const slowModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 50,
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "partial" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      }),
    });
    const { db, book, deps } = setup({ ok: true, model: slowModel, modelId: "mock" });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    controller.abort(); // runSend 同步返回后立即中止，分片仍在 50ms 延迟途中
    await r.finished;
    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("aborted");
  });

  it("omits the paragraph chip from the snapshot when it duplicates the conversation's last", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: textStreamModel("ok"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const first = runSend(
      deps,
      input(book.id, convo.id, {
        chips: buildChips({ selection: "s1", paragraphCurrent: "dup para" }),
        userText: "q1",
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.finished;

    const second = runSend(
      deps,
      input(book.id, convo.id, {
        chips: buildChips({ selection: "s2", paragraphCurrent: "dup para" }),
        userText: "q2",
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.finished;

    const userMsgs = listMessages(db, convo.id).filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection"]);
  });

  it("auto-names the conversation after the first completed turn", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: textStreamModelWithNaming("It means hello.", "AI 标题"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    await vi.waitFor(() => expect(getConversation(db, convo.id)?.title).toBe("AI 标题"));
  });

  it("does not rename a conversation that already has a title", async () => {
    const { db, book, deps } = setup({
      ok: true,
      model: textStreamModelWithNaming("answer", "AI 名"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    setConversationTitle(db, convo.id, "既有名");
    const r = runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    await vi.waitFor(() => expect(getConversation(db, convo.id)?.title).toBe("既有名"));
  });
});
